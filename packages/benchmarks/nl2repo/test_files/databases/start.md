## Databases Project Dependency Library Configuration

Databases is an **asynchronous database library** that provides simple yet powerful asynchronous database support. It supports PostgreSQL, MySQL, and SQLite, and integrates with SQLAlchemy Core to provide type-safe query building and execution.

## Natural Language Instructions (Prompt)

Please create a Python project named Databases that implements an asynchronous database operations library. The project should include the following features:

1. **Asynchronous Database Connection Management**: Implement asynchronous database connection pool management, supporting multiple database backends (PostgreSQL, MySQL, SQLite). Each asynchronous task maintains independent database connections, ensuring concurrency safety and connection isolation. Should support connection lifecycle management, automatic connection acquisition/release, and connection pool configuration optimization.

2. **Unified Query Execution Interface**: Provide a unified asynchronous query execution interface, supporting raw SQL and SQLAlchemy Core expressions, automatically handling parameter binding, type conversion, and result set encapsulation. Should support multiple query modes: single row, multiple rows, single value, iteration, etc., as well as batch operation optimization.

3. **Transaction Management System**: Implement complete asynchronous transaction management functionality, supporting nested transactions, automatic commit/rollback, decorator patterns, and transaction isolation in multi-task environments. Ensure data consistency and ACID properties, support forced rollback mode for testing environments.

4. **Database Backend Abstraction**: Provide a unified database backend abstraction interface, supporting seamless integration of multiple database drivers, including PostgreSQL (asyncpg, aiopg), MySQL (aiomysql, asyncmy), SQLite (aiosqlite), etc. Achieve database-agnostic code writing through the abstraction layer.

5. **Data Type Handling and Type Safety**: Provide complete Python data type to database type mapping, supporting automatic type conversion, type validation, and type-safe query building. Ensure data consistency and security through the SQLAlchemy type system, supporting complex data types such as JSON, datetime, numeric, etc.

6. **Web Framework Integration Support**: Provide seamless integration with mainstream web frameworks, supporting FastAPI, Starlette and other ASGI frameworks, including database middleware, dependency injection, connection lifecycle management, etc. Implement database best practices in web applications.

7. **Connection Pool Management and Task Isolation**: Implement asyncio.Task-based connection pool management mechanism, using WeakKeyDictionary to implement task-to-connection mapping, supporting connection reuse and automatic release, ensuring each asynchronous task has independent database connections.

8. **Query Building and Parameter Binding**: Support SQLAlchemy Core expressions and raw SQL queries, automatically handle parameter binding and query compilation, provide type-safe query interfaces. Integrate with SQLAlchemy's query compilation system, support pre-compiled parameters and query optimization.

9. **Batch Operations and Performance Optimization**: Support batch insert, update, and delete operations, optimize large data processing performance through the execute_many method, reducing database round-trip times. Support asynchronous iterators for processing large datasets, implementing memory optimization and streaming processing.

10. **Error Handling and Exception Management**: Provide comprehensive error handling mechanisms, including connection errors, transaction rollbacks, query execution exceptions, etc., ensuring application robustness and data consistency. Implement automatic transaction rollback, connection cleanup, and graceful degradation mechanisms.

**Core File Requirements**: The project must include a comprehensive setup.py file that not only configures the project as an installable package (supporting pip install), but also declares a complete dependency list (including sqlalchemy>=2.0.7, asyncpg>=0.27.0, aiosqlite>=0.17.0, aiomysql>=0.1.0, asyncmy>=0.2.0, psycopg>=3.0.0, pymysql>=1.0.0, pytest>=7.0.0, pytest-asyncio>=0.21.0, httpx>=0.24.0, starlette>=0.20.0, fastapi>=0.100.0 and other core libraries). The setup.py should be able to verify that all functional modules work properly, while providing databases/__init__.py as a unified API entry point, importing Database and DatabaseURL core classes from the core module, exporting Connection, Transaction and other interface classes, and providing version information, enabling users to access all major functionality through simple "from databases import Database, DatabaseURL" statements and allowing users to access all functionality via `from databases import **`. In core.py, there should be a Database class to manage database connection pools and transactions, a Connection class to manage individual connections, a Transaction class to manage transaction lifecycles, using ContextVar and WeakKeyDictionary to implement task-level connection isolation and transaction management. In interfaces.py, define abstract interfaces such as Backend, ConnectionBackend, TransactionBackend, etc., ensuring consistency across different database backends. In the backends/ directory, provide specific implementations for each database type, including connection pool configuration, SSL support, dialect processing, etc. The project should ultimately include core modules such as connection management, transaction processing, query execution, type safety, web integration, etc., along with complete test cases, forming a reproducible asynchronous database operations library.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.4

### Core Dependency Library Versions

```Plain
aiomysql                   0.2.0
aiopg                      1.4.0
aiosqlite                  0.20.0
anyio                      4.10.0
async-timeout              4.0.3
asyncmy                    0.2.9
asyncpg                    0.29.0
attrs                      25.3.0
autoflake                  1.4
backports.tarfile          1.2.0
black                      22.6.0
certifi                    2025.8.3
cffi                       1.17.1
charset-normalizer         3.4.3
click                      8.2.1
coverage                   7.10.4
cryptography               45.0.6
docutils                   0.22
ghp-import                 2.1.0
greenlet                   3.2.4
h11                        0.14.0
httpcore                   0.17.3
httpx                      0.24.1
idna                       3.10
importlib_metadata         8.7.0
iniconfig                  2.1.0
isort                      5.10.1
jaraco.classes             3.4.0
jaraco.context             6.0.1
jaraco.functools           4.3.0
jeepney                    0.9.0
Jinja2                     3.1.6
keyring                    25.6.0
Markdown                   3.3.7
markdown-it-py             4.0.0
MarkupSafe                 3.0.2
mdurl                      0.1.2
mergedeep                  1.3.4
mkautodoc                  0.1.0
mkdocs                     1.3.1
mkdocs-material            8.3.9
mkdocs-material-extensions 1.3.1
more-itertools             10.7.0
mypy                       0.971
mypy_extensions            1.1.0
nh3                        0.3.0
packaging                  25.0
pathspec                   0.12.1
pip                        25.2
pkginfo                    1.12.1.2
platformdirs               4.3.8
pluggy                     1.6.0
psycopg                    3.1.18
psycopg2-binary            2.9.10
py                         1.11.0
pycparser                  2.22
pyflakes                   3.4.0
Pygments                   2.19.2
pymdown-extensions         10.4
PyMySQL                    1.1.0
python-dateutil            2.9.0.post0
PyYAML                     6.0.2
pyyaml_env_tag             1.1
readme_renderer            44.0
requests                   2.31.0
requests-toolbelt          1.0.0
rfc3986                    2.0.0
rich                       14.1.0
SecretStorage              3.3.3
setuptools                 69.0.3
six                        1.17.0
sniffio                    1.3.1
SQLAlchemy                 2.0.43
starlette                  0.36.2
tomli                      2.2.1
twine                      4.0.1
typing_extensions          4.14.1
urllib3                    2.5.0
watchdog                   6.0.0
wheel                      0.38.1
zipp                       3.23.0
```


## Databases Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── CHANGELOG.md
├── LICENSE.md
├── README.md
├── databases
│   ├── __init__.py
│   ├── backends
│   │   ├── __init__.py
│   │   ├── aiopg.py
│   │   ├── asyncmy.py
│   │   ├── common
│   │   │   ├── __init__.py
│   │   │   ├── records.py
│   │   ├── compilers
│   │   │   ├── __init__.py
│   │   │   ├── psycopg.py
│   │   ├── dialects
│   │   │   ├── __init__.py
│   │   │   ├── psycopg.py
│   │   ├── mysql.py
│   │   ├── postgres.py
│   │   ├── sqlite.py
│   ├── core.py
│   ├── importer.py
│   ├── interfaces.py
│   ├── py.typed
├── docs
│   ├── connections_and_transactions.md
│   ├── contributing.md
│   ├── database_queries.md
│   ├── index.md
│   ├── tests_and_migrations.md
├── mkdocs.yml
├── scripts
│   ├── README.md
│   ├── build
│   ├── check
│   ├── clean
│   ├── coverage
│   ├── docs
│   ├── install
│   ├── lint
│   ├── publish
│   ├── test
├── setup.cfg
└── setup.py
    

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from databases.backends.aiopg import AiopgBackend
from databases.backends.postgres import PostgresBackend
from databases.importer import ImportFromStringError, import_from_string
from databases.core import Connection, Transaction, Database, DatabaseURL
from databases.interfaces import DatabaseBackend, ConnectionBackend, TransactionBackend, Record
```

#### 2. Database Class - Database Connection Management

**Function**: Manage database connection pools, providing asynchronous database operation interfaces.

**Class Definition**:
```python
from databases.core import Database
class Database:
    SUPPORTED_BACKENDS = {
        "postgresql": "databases.backends.postgres:PostgresBackend",
        "postgresql+aiopg": "databases.backends.aiopg:AiopgBackend",
        "postgres": "databases.backends.postgres:PostgresBackend",
        "mysql": "databases.backends.mysql:MySQLBackend",
        "mysql+asyncmy": "databases.backends.asyncmy:AsyncMyBackend",
        "sqlite": "databases.backends.sqlite:SQLiteBackend",
    }

    _connection_map: "weakref.WeakKeyDictionary[asyncio.Task, 'Connection']"

    def __init__(
        self,
        url: typing.Union[str, "DatabaseURL"],
        *,
        force_rollback: bool = False,
        **options: typing.Any,
    ):
        self.url = DatabaseURL(url)
        self.options = options
        self.is_connected = False
        self._connection_map = weakref.WeakKeyDictionary()

        self._force_rollback = force_rollback

        backend_str = self._get_backend()
        backend_cls = import_from_string(backend_str)
        assert issubclass(backend_cls, DatabaseBackend)
        self._backend = backend_cls(self.url, **self.options)

        # When `force_rollback=True` is used, we use a single global
        # connection, within a transaction that always rolls back.
        self._global_connection: typing.Optional[Connection] = None
        self._global_transaction: typing.Optional[Transaction] = None

    @property
    def _current_task(self) -> asyncio.Task:
        """
        Get the current asyncio.Task.
        Returns the current asyncio.Task.
        """

    @property
    def _connection(self) -> typing.Optional["Connection"]:
        return self._connection_map.get(self._current_task)

    @_connection.setter
    def _connection(
        self, connection: typing.Optional["Connection"]
    ) -> typing.Optional["Connection"]:
        """
        Set the current connection.
        Returns the current connection.
        """


    async def connect(self) -> None:
        """
        Establish the connection pool.
        """


    async def disconnect(self) -> None:
        """
        Close all connections in the connection pool.
        """
       

    async def __aenter__(self) -> "Database":
        """
        Enter the database context manager.
        Returns the database instance.
        """

    async def __aexit__(
        self,
        exc_type: typing.Optional[typing.Type[BaseException]] = None,
        exc_value: typing.Optional[BaseException] = None,
        traceback: typing.Optional[TracebackType] = None,
    ) -> None:
        """
        Exit the database context manager.
        """

    async def fetch_all(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.List[Record]:
        """
        Fetch all the rows from the database.
        Returns a list of records.
        """

    async def fetch_one(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.Optional[Record]:
        """
        Fetch one row from the database.
        Returns a single record.
        """

    async def fetch_val(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
        column: typing.Any = 0,
    ) -> typing.Any:
        """
        Fetch a single value from the database.
        Returns a single value.
        """

    async def execute(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.Any:
        """
        Execute a query on the database.
        Returns the result of the query.
        """

    async def execute_many(
        self, query: typing.Union[ClauseElement, str], values: list
    ) -> None:
        """
        Execute a batch of queries on the database.
        Returns None.
        """

    async def iterate(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.AsyncGenerator[typing.Mapping, None]:
        """
        Iterate over the results of a query.
        Returns an asynchronous generator of records.
        """

    def connection(self) -> "Connection":
        """
        Get a connection from the database.
        Returns a connection.
        """
    def transaction(
        self, *, force_rollback: bool = False, **kwargs: typing.Any
    ) -> "Transaction":
        """
        Get a transaction from the database.
        Returns a transaction.
        """

    @contextlib.contextmanager
    def force_rollback(self) -> typing.Iterator[None]:
        """
        Force a rollback on the database.
        Returns an iterator of None.
        """

    def _get_backend(self) -> str:
        """
        Get the backend of the database.
        Returns the backend.
        """
```


#### 3. DatabaseURL Class - Database URL Parsing

**Function**: Parse and validate database connection URL, supporting various database dialects.

**Class Definition**:
```python
from databases.core import DatabaseURL
class DatabaseURL:
    def __init__(self, url: typing.Union[str, "DatabaseURL"]):
        if isinstance(url, DatabaseURL):
            self._url: str = url._url
        elif isinstance(url, str):
            self._url = url
        else:
            raise TypeError(
                f"Invalid type for DatabaseURL. Expected str or DatabaseURL, got {type(url)}"
            )

    @property
    def components(self) -> SplitResult:
        """
        Get the components of the database URL.
        Returns the components.
        """

    @property
    def scheme(self) -> str:
        """
        Get the scheme of the database URL.
        Returns the scheme.
        """
    @property
    def dialect(self) -> str:
        """
        Get the dialect of the database URL.
        Returns the dialect.
        """
    @property
    def driver(self) -> str:
        if "+" not in self.components.scheme:
            return ""
        return self.components.scheme.split("+", 1)[1]

    @property
    def userinfo(self) -> typing.Optional[bytes]:
        """
        Get the userinfo of the database URL.
        Returns the userinfo.
        """

    @property
    def username(self) -> typing.Optional[str]:
        """
        Get the username of the database URL.
        Returns the username.
        """

    @property
    def password(self) -> typing.Optional[str]:
        """
        Get the password of the database URL.
        Returns the password.
        """

    @property
    def hostname(self) -> typing.Optional[str]:
        """
        Get the hostname of the database URL.
        Returns the hostname.
        """

    @property
    def port(self) -> typing.Optional[int]:
        """
        Get the port of the database URL.
        Returns the port.
        """
    @property
    def netloc(self) -> typing.Optional[str]:
        """
        Get the netloc of the database URL.
        Returns the netloc.
        """
    @property
    def database(self) -> str:
        """
        Get the database of the database URL.
        Returns the database.
        """

    @property
    def options(self) -> dict:
        """
        Get the options of the database URL.
        Returns the options.
        """

    def replace(self, **kwargs: typing.Any) -> "DatabaseURL":
        """
        Function Description:
            Replace components of the current database URL and return a new DatabaseURL instance.
            Supports replacing parameters such as username, password, hostname, port, database name, dialect, and driver.
            Automatically handles the reconstruction of network location (netloc) and path.

        Parameter Explanation:
            **kwargs: Arbitrary keyword arguments, supports the following parameters:
                - username: Replace username
                - password: Replace password
                - hostname: Replace hostname
                - port: Replace port
                - database: Replace database name
                - dialect: Replace database dialect
                - driver: Replace database driver
                Other parameters will be passed to the components._replace method

        Return Value:
            DatabaseURL: Returns a DatabaseURL instance containing the new URL components
        """

    @property
    def obscure_password(self) -> str:
        if self.password:
            return self.replace(password="********")._url
        return self._url

    def __str__(self) -> str:
        return self._url

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}({repr(self.obscure_password)})"

    def __eq__(self, other: typing.Any) -> bool:
        return str(self) == str(other)
```

#### 4. DatabaseBackend Class - Database Backend

**Function**: Manage the database backend, providing connection pool management and query execution capabilities.

**Class Definition**:
```python
from databases.interfaces import DatabaseBackend
class DatabaseBackend:
    async def connect(self) -> None:
        raise NotImplementedError()  # pragma: no cover

    async def disconnect(self) -> None:
        raise NotImplementedError()  # pragma: no cover

    def connection(self) -> "ConnectionBackend":
        raise NotImplementedError()  # pragma: no cover
```

#### 5. Connection Class - Database Connection

**Function**: Manage a single database connection, providing query execution interfaces.

**Class Definition**:
```python
from databases.interfaces import Connection
class Connection:
    def __init__(self, database: Database, backend: DatabaseBackend) -> None:
        self._database = database
        self._backend = backend

        self._connection_lock = asyncio.Lock()
        self._connection = self._backend.connection()
        self._connection_counter = 0

        self._transaction_lock = asyncio.Lock()
        self._transaction_stack: typing.List[Transaction] = []

        self._query_lock = asyncio.Lock()

    async def __aenter__(self) -> "Connection":
        """
        Enter the connection context manager.
        Returns the connection instance.
        """

    async def __aexit__(
        self,
        exc_type: typing.Optional[typing.Type[BaseException]] = None,
        exc_value: typing.Optional[BaseException] = None,
        traceback: typing.Optional[TracebackType] = None,
    ) -> None:
        """
        Exit the connection context manager.
        Returns None.
        """

    async def fetch_all(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.List[Record]:
        """
        Fetch all the rows from the database.
        Returns a list of records.
        """

    async def fetch_one(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.Optional[Record]:
        """
        Fetch one row from the database.
        Returns a single record.
        """

    async def fetch_val(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
        column: typing.Any = 0,
    ) -> typing.Any:
        """
        Fetch a single value from the database.
        Returns a single value.
        """

    async def execute(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.Any:
        """
        Execute a query on the database.
        Returns the result of the query.
        """

    async def execute_many(
        self, query: typing.Union[ClauseElement, str], values: list
    ) -> None:
        """
        Execute a batch of queries on the database.
        Returns None.
        """

    async def iterate(
        self,
        query: typing.Union[ClauseElement, str],
        values: typing.Optional[dict] = None,
    ) -> typing.AsyncGenerator[typing.Any, None]:
        """
        Iterate over the results of a query.
        Returns an asynchronous generator of records.
        """

    def transaction(
        self, *, force_rollback: bool = False, **kwargs: typing.Any
    ) -> "Transaction":
        def connection_callable() -> Connection:
            """
            Get a connection from the database.
            Returns a connection.
            """

    @property
    def raw_connection(self) -> typing.Any:
        return self._connection.raw_connection


    @staticmethod
    def _build_query(
        query: typing.Union[ClauseElement, str], values: typing.Optional[dict] = None
    ) -> ClauseElement:
        """
        Build a query from a string or a SQLAlchemy ClauseElement.
        Returns a SQLAlchemy ClauseElement.
        """
```


#### 6. Transaction Class - Transaction Management

**Function**: Manage database transactions, supporting automatic commit and rollback.

**Class Definition**:
```python
from databases.core import Transaction

class Transaction:
    def __init__(
        self,
        connection_callable: typing.Callable[[], Connection],
        force_rollback: bool,
        **kwargs: typing.Any,
    ) -> None:
        self._connection_callable = connection_callable
        self._force_rollback = force_rollback
        self._extra_options = kwargs

    @property
    def _connection(self) -> "Connection":
        # Returns the same connection if called multiple times
        """
        Get the same connection if called multiple times.
        Returns the same connection.
        """

    @property
    def _transaction(self) -> typing.Optional["TransactionBackend"]:
        """
        Get the transaction backend.
        Returns the transaction backend.
        """

    @_transaction.setter
    def _transaction(
        self, transaction: typing.Optional["TransactionBackend"]
    ) -> typing.Optional["TransactionBackend"]:

    async def __aenter__(self) -> "Transaction":
        """
        Called when entering `async with database.transaction()`
        Returns the transaction instance.
        """

    async def __aexit__(
        self,
        exc_type: typing.Optional[typing.Type[BaseException]] = None,
        exc_value: typing.Optional[BaseException] = None,
        traceback: typing.Optional[TracebackType] = None,
    ) -> None:
        """
        Called when exiting `async with database.transaction()`
        Returns None.
        """


    def __await__(self) -> typing.Generator[None, None, "Transaction"]:
        """
        Called if using the low-level `transaction = await database.transaction()`
        Returns a generator of None.
        """

    def __call__(self, func: _CallableType) -> _CallableType:
        """
        Called if using `@database.transaction()` as a decorator.
        Returns a wrapper function.
        """

        @functools.wraps(func)
        async def wrapper(*args: typing.Any, **kwargs: typing.Any) -> typing.Any:
            """
            Wrap the function with a transaction.
            Returns the result of the function.
            """

    async def start(self) -> "Transaction":    
        """
        Start the transaction.
        Returns the transaction instance.
        """
    async def commit(self) -> None:
        """
        Commit the transaction.
        Returns None.
        """
    async def rollback(self) -> None:
        """
        Rollback the transaction.
        Returns None.
        """
```

#### 7. ImportFromStringError Class

**Functional Description**:
`ImportFromStringError` is a custom exception class defined in `databases`, used to handle errors that may occur when importing modules or attributes from strings.

**Class Definition**:
```python
from databases.importer import ImportFromStringError
class ImportFromStringError(Exception):
    pass
```

##### import_from_string Function

**Functional Description**:
A helper function for importing modules or module attributes from strings.

**Function Signature**:
```python
def import_from_string(import_str: str) -> typing.Any:
```

**Parameters**:
- `import_str` (str): The module or attribute string to import, in the format `module:attribute`

**Return Value**:
- Returns the imported module or attribute

**Exceptions Raised**:
- `ImportFromStringError`: Raised when an error occurs during the import process

#### 8. AiopgBackend Class

**Functional Description**:
`AiopgBackend` is an asynchronous PostgreSQL database backend implementation based on `aiopg`, providing connection pool management and query execution capabilities for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.aiopg import AiopgBackend
class AiopgBackend(DatabaseBackend):
    def __init__(
        self, database_url: typing.Union[DatabaseURL, str], **options: typing.Any
    ) -> None:
        self._database_url = DatabaseURL(database_url)
        self._options = options
        self._dialect = self._get_dialect()
        self._pool: typing.Union[aiopg.Pool, None] = None

    def _get_dialect(self) -> Dialect:
        dialect = PGDialect_psycopg(
            json_serializer=json.dumps, json_deserializer=lambda x: x
        )
        dialect.statement_compiler = PGCompiler_psycopg
        dialect.implicit_returning = True
        dialect.supports_native_enum = True
        dialect.supports_smallserial = True  # 9.2+
        dialect._backslash_escapes = False
        dialect.supports_sane_multi_rowcount = True  # psycopg 2.0.9+
        dialect._has_native_hstore = True
        dialect.supports_native_decimal = True

        return dialect
    def _get_connection_kwargs(self) -> dict:
        """
        Get the connection kwargs of the database.
        Returns the connection kwargs.
        """

    async def connect(self) -> None:
        """
        Connect to the database.
        Returns None.
        """

    async def disconnect(self) -> None:
        """
        Disconnect from the database.
        Returns None.
        """

    def connection(self) -> "AiopgConnection":
        """
        Get the connection from the database.
        Returns the connection.
        """
```

**Initialization Parameters**:
- `database_url`: Database connection URL, which can be a string or `DatabaseURL` object
- `options`: Other connection options, such as connection pool size, etc.

**Main Methods**:

##### `connect() -> None`
**Function**: Establish database connection pool
**Parameters**: None
**Returns**: None
**Exceptions**:
- `AssertionError`: If the connection pool already exists

##### `disconnect() -> None`
**Function**: Close database connection pool
**Parameters**: None
**Returns**: None
**Exceptions**:
- `AssertionError`: If the connection pool does not exist

##### `connection() -> AiopgConnection`
**Function**: Create a new database connection
**Returns**: `AiopgConnection` instance

**Example**:
```python
from databases import DatabaseURL
from databases.backends.aiopg import AiopgBackend

# Initialize database connection
backend = AiopgBackend(
    database_url=DatabaseURL("postgresql://user:password@localhost:5432/dbname"),
    min_size=5,
    max_size=20
)

# Connect to database
await backend.connect()

try:
    # Get connection
    connection = backend.connection()
    await connection.acquire()
    
    # Execute query
    results = await connection.fetch_all("SELECT * FROM users")
    
finally:
    # Close connection
    await connection.release()
    await backend.disconnect()
```

#### 9. Record Class

**Functional Description**:
`Record` is a class that represents a single row of data in database query results, providing a dictionary-like interface to access column data and handling the conversion from database types to Python types.

**Class Definition**:
```python
from databases.backends.common.records import Record
class Record(RecordInterface):
    __slots__ = (
        "_row",
        "_result_columns",
        "_dialect",
        "_column_map",
        "_column_map_int",
        "_column_map_full",
    )

    def __init__(
        self,
        row: typing.Any,
        result_columns: tuple,
        dialect: Dialect,
        column_maps: typing.Tuple[
            typing.Mapping[typing.Any, typing.Tuple[int, TypeEngine]],
            typing.Mapping[int, typing.Tuple[int, TypeEngine]],
            typing.Mapping[str, typing.Tuple[int, TypeEngine]],
        ],
    ) -> None:
        self._row = row
        self._result_columns = result_columns
        self._dialect = dialect
        self._column_map, self._column_map_int, self._column_map_full = column_maps

    @property
    def _mapping(self) -> typing.Mapping:
        """
        Get the mapping of the record.
        Returns the mapping.
        """
    def keys(self) -> typing.KeysView:
        """
        Get the keys of the record.
        Returns the keys.
        """
    def values(self) -> typing.ValuesView:
        """
        Get the values of the record.
        Returns the values.
        """
    def __getitem__(self, key: typing.Any) -> typing.Any:
        """
        Get the item from the record.
        Returns the item.
        """
    def __iter__(self) -> typing.Iterator:
        """
        Iterate over the record.
        Returns an iterator.
        """
    def __len__(self) -> int:
        """
        Get the length of the record.
        Returns the length.
        """
    def __getattr__(self, name: str) -> typing.Any:
        """
        Get the attribute from the record.
        Returns the attribute.
        """
```

#### 10. _EmptyNetloc Class

**Functional Description**:
`_EmptyNetloc` is a subclass of `str` that overrides the `__bool__` method to return `True`, allowing it to be used as a placeholder for an empty netloc.

**Class Definition**:
```python
from databases.core import _EmptyNetloc
class _EmptyNetloc(str):
    def __bool__(self) -> bool:
        return True
```


#### 11. CompilationContext Class

**Functional Description**:
`CompilationContext` is a class that provides a context for the compilation of SQL queries.

**Class Definition**:
```python
from databases.backends.asyncmy import CompilationContext
class CompilationContext:
    def __init__(self, context: ExecutionContext):
        self.context = context
```
```python
from databases.backends.aiopg import CompilationContext
class CompilationContext:
    def __init__(self, context: ExecutionContext):
        self.context = context
```
```python
from databases.backends.mysql import CompilationContext
class CompilationContext:
    def __init__(self, context: ExecutionContext):
        self.context = context
```
```python
from databases.backends.sqlite import CompilationContext
class CompilationContext:
    def __init__(self, context: ExecutionContext):
        self.context = context
```

#### 12. AsyncMyConnection Class

**Functional Description**:
`AsyncMyConnection` is an asynchronous MySQL database backend implementation based on `asyncmy`, providing connection pool management and query execution capabilities for MySQL databases.

**Class Definition**:
```python
from databases.backends.asyncmy import AsyncMyConnection
class AsyncMyConnection(ConnectionBackend):
    def __init__(self, database: AsyncMyBackend, dialect: Dialect):
        self._database = database
        self._dialect = dialect
        self._connection: typing.Optional[asyncmy.Connection] = None

    async def acquire(self) -> None:
        """
        Acquire a connection from the database.
        Returns None.
        """
    async def release(self) -> None:
        """
        Release a connection to the database.
        Returns None.
        """

    async def fetch_all(self, query: ClauseElement) -> typing.List[RecordInterface]:
        """
        Fetch all the rows from the database.
        Returns a list of records.
        """
    async def fetch_one(self, query: ClauseElement) -> typing.Optional[RecordInterface]:
        """
        Fetch one row from the database.
        Returns a single record.
        """
    async def execute(self, query: ClauseElement) -> typing.Any:
        """
        Execute a query on the database.
        Returns the result of the query.
        """
    async def execute_many(self, queries: typing.List[ClauseElement]) -> None:
        """
        Execute a batch of queries on the database.
        Returns None.
        """
    async def iterate(
        self, query: ClauseElement
    ) -> typing.AsyncGenerator[typing.Any, None]:
        """
        Iterate over the results of a query.
        Returns an asynchronous generator of records.
        """
    def transaction(self) -> TransactionBackend:
        """
        Get a transaction from the database.
        Returns a transaction.
        """
    def _compile(self, query: ClauseElement) -> typing.Tuple[str, list, tuple]:
        """
        Compile a query.
        Returns a tuple of the query string, arguments, result columns, and context.
        """

    @property
    def raw_connection(self) -> asyncmy.connection.Connection:
        """
        Get the raw connection from the database.
        Returns the raw connection.
        """
```

#### 13. AsyncMyTransaction Class

**Functional Description**:
`AsyncMyTransaction` is an asynchronous MySQL database backend implementation based on `asyncmy`, providing transaction support for MySQL databases.

**Class Definition**:
```python
from databases.backends.asyncmy import AsyncMyTransaction
class AsyncMyTransaction(TransactionBackend):
    def __init__(self, connection: AsyncMyConnection):
        self._connection = connection
        self._is_root = False
        self._savepoint_name = ""

    async def start(
        self, is_root: bool, extra_options: typing.Dict[typing.Any, typing.Any]
    ) -> None:
        """
        Start the transaction.
        Returns None.
        """
    async def commit(self) -> None:
        """
        Commit the transaction.
        Returns None.
        """
    async def rollback(self) -> None:
        """
        Rollback the transaction.
        Returns None.
        """
```

#### 14. SQLitePool Class

**Functional Description**:
`SQLitePool` is a class that provides a connection pool for SQLite databases.

**Class Definition**:
```python
from databases.backends.sqlite import SQLitePool
class SQLitePool:
    def __init__(self, url: DatabaseURL, **options: typing.Any) -> None:
        self._database = url.database
        self._memref = None
        # add query params to database connection string
        if url.options:
            self._database += "?" + urlencode(url.options)
        self._options = options

        if url.options and "cache" in url.options:
            # reference to a connection to the cached in-memory database must be held to keep it from being deleted
            self._memref = sqlite3.connect(self._database, **self._options)

    async def acquire(self) -> aiosqlite.Connection:
        """
        Acquire a connection from the database.
        Returns a connection.
        """ 
    async def release(self, connection: aiosqlite.Connection) -> None:
        """
        Release a connection to the database.
        Returns None.
        """
```

#### 15. SQLiteConnection Class

**Functional Description**:
`SQLiteConnection` is a class that provides a connection for SQLite databases.

**Class Definition**:
```python
from databases.backends.sqlite import SQLiteConnection

class SQLiteConnection(ConnectionBackend):
    def __init__(self, pool: SQLitePool, dialect: Dialect):
        self._pool = pool
        self._dialect = dialect
        self._connection: typing.Optional[aiosqlite.Connection] = None

    async def acquire(self) -> None:
        assert self._connection is None, "Connection is already acquired"
        self._connection = await self._pool.acquire()

    async def release(self) -> None:
        assert self._connection is not None, "Connection is not acquired"
        await self._pool.release(self._connection)
        self._connection = None

    async def fetch_all(self, query: ClauseElement) -> typing.List[Record]:
        """
        Execute query and return all result records
        
        Args:
            query: SQL query statement or ClauseElement object
            
        Returns:
            List of Record objects containing all query results
            
        Raises:
            AssertionError: If connection is not acquired
        """

    async def fetch_one(self, query: ClauseElement) -> typing.Optional[Record]:
        """
        Execute query and return single result record
        
        Args:
            query: SQL query statement or ClauseElement object
            
        Returns:
            Single Record object, returns None if no results
            
        Raises:
            AssertionError: If connection is not acquired
        """

    async def execute(self, query: ClauseElement) -> typing.Any:
        """
        Execute SQL statement (INSERT/UPDATE/DELETE, etc.)
        
        Args:
            query: SQL statement or ClauseElement object
            
        Returns:
            Last inserted row ID or number of affected rows
            
        Raises:
            AssertionError: If connection is not acquired
        """

    async def execute_many(self, queries: typing.List[ClauseElement]) -> None:
        assert self._connection is not None, "Connection is not acquired"
        for single_query in queries:
            await self.execute(single_query)

    async def iterate(
        self, query: ClauseElement
    ) -> typing.AsyncGenerator[typing.Any, None]:
        """
        Iterate query results as async generator
        
        Args:
            query: SQL query statement or ClauseElement object
            
        Yields:
            Record objects of query results
            
        Raises:
            AssertionError: If connection is not acquired
        """

    def transaction(self) -> TransactionBackend:
        """
        Create transaction backend instance
        
        Returns:
            SQLite transaction backend object
        """

        

    def _compile(self, query: ClauseElement) -> typing.Tuple[str, list, tuple]:
        """
        Compile SQL query statement
        
        Args:
            query: ClauseElement object to compile
            
        Returns:
            Tuple containing compiled SQL string, parameter list, result column mapping and compilation context
        """

    @property
    def raw_connection(self) -> aiosqlite.core.Connection:
        assert self._connection is not None, "Connection is not acquired"
        return self._connection


```



#### 16. SQLiteTransaction Class

**Functional Description**:
`SQLiteTransaction` is a class that provides a transaction for SQLite databases.

**Class Definition**:
```python
from databases.backends.sqlite import SQLiteTransaction
class SQLiteTransaction(TransactionBackend):
    def __init__(self, connection: SQLiteConnection):
        self._connection = connection
        self._is_root = False
        self._savepoint_name = ""

    async def start(
        self, is_root: bool, extra_options: typing.Dict[typing.Any, typing.Any]
    ) -> None:
        """
        Start the transaction.
        Returns None.
        """
    async def commit(self) -> None:
        """
        Commit the transaction.
        Returns None.
        """
    async def rollback(self) -> None:
        """
        Rollback the transaction.
        Returns None.
        """
```

#### 17. PostgresConnection Class

**Functional Description**:
`PostgresConnection` is a class that provides a connection for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.postgres import PostgresConnection
class PostgresConnection(ConnectionBackend):
    def __init__(self, database: PostgresBackend, dialect: Dialect):
        self._database = database
        self._dialect = dialect
        self._connection: typing.Optional[asyncpg.connection.Connection] = None

    async def acquire(self) -> None:
        """
        Acquire a connection from the database.
        Returns None.
        """
    async def release(self) -> None:
        """
        Release a connection to the database.
        Returns None.
        """
    async def fetch_all(self, query: ClauseElement) -> typing.List[RecordInterface]:
        """
        Fetch all the rows from the database.
        Returns a list of records.
        """
    async def fetch_one(self, query: ClauseElement) -> typing.Optional[RecordInterface]:
        """
        Fetch one row from the database.
        Returns a single record.
        """
    async def fetch_val(
        self, query: ClauseElement, column: typing.Any = 0
    ) -> typing.Any:
        """
        Fetch a single value from the database.
        Returns a single value.
        """
    async def execute(self, query: ClauseElement) -> typing.Any:
        """
        Execute a query on the database.
        Returns the result of the query.
        """
    async def execute_many(self, queries: typing.List[ClauseElement]) -> None:
        """
        Execute a batch of queries on the database.
        Returns None.
        """
    async def iterate(
        self, query: ClauseElement
    ) -> typing.AsyncGenerator[typing.Any, None]:
        """
        Iterate over the results of a query.
        Returns an asynchronous generator of records.
        """
    def transaction(self) -> TransactionBackend:
        """
        Get a transaction from the database.
        Returns a transaction.
        """
    def _compile(self, query: ClauseElement) -> typing.Tuple[str, list, tuple]:
        """
        Compile a query.
        Returns a tuple of the query string, arguments, result columns, and context.
        """

    @property
    def raw_connection(self) -> asyncpg.connection.Connection:
        """
        Get the raw connection from the database.
        Returns the raw connection.
        """
```

#### 18. PostgresTransaction Class

**Functional Description**:
`PostgresTransaction` is a class that provides a transaction for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.postgres import PostgresTransaction
class PostgresTransaction(TransactionBackend):
    def __init__(self, connection: PostgresConnection):
        self._connection = connection
        self._transaction: typing.Optional[asyncpg.transaction.Transaction] = None

    async def start(
        self, is_root: bool, extra_options: typing.Dict[typing.Any, typing.Any]
    ) -> None:
        """
        Start the transaction.
        Returns None.
        """
    async def commit(self) -> None:
        """
        Commit the transaction.
        Returns None.
        """
    async def rollback(self) -> None:
        """
        Rollback the transaction.
        Returns None.
        """
```

#### 19. MySQLConnection Class

**Functional Description**:
`MySQLConnection` is a class that provides a connection for MySQL databases.

**Class Definition**:
```python
from databases.backends.mysql import MySQLConnection
class MySQLConnection(ConnectionBackend):
    def __init__(self, database: MySQLBackend, dialect: Dialect):
        self._database = database
        self._dialect = dialect
        self._connection: typing.Optional[aiomysql.Connection] = None

    async def acquire(self) -> None:
        """
        Acquire a connection from the database.
        Returns None.
        """
    async def release(self) -> None:
        """
        Release a connection to the database.
        Returns None.
        """
    async def fetch_all(self, query: ClauseElement) -> typing.List[RecordInterface]:
        """
        Fetch all the rows from the database.
        Returns a list of records.
        """
    async def fetch_one(self, query: ClauseElement) -> typing.Optional[RecordInterface]:
        """
        Fetch one row from the database.
        Returns a single record.
        """
    async def execute(self, query: ClauseElement) -> typing.Any:
        """
        Execute a query on the database.
        Returns the result of the query.
        """
    async def execute_many(self, queries: typing.List[ClauseElement]) -> None:
        """
        Execute a batch of queries on the database.
        Returns None.
        """
    async def iterate(
        self, query: ClauseElement
    ) -> typing.AsyncGenerator[typing.Any, None]:
        """
        Iterate over the results of a query.
        Returns an asynchronous generator of records.
        """
    def transaction(self) -> TransactionBackend:
        """
        Get a transaction from the database.
        Returns a transaction.
        """
    def _compile(self, query: ClauseElement) -> typing.Tuple[str, list, tuple]:
        """
        Compile a query.
        Returns a tuple of the query string, arguments, result columns, and context.
        """
        compiled = query.compile(
            dialect=self._dialect, compile_kwargs={"render_postcompile": True}
        )

    @property
    def raw_connection(self) -> aiomysql.connection.Connection:
        """
        Get the raw connection from the database.
        Returns the raw connection.
        """
```

#### 20. MySQLTransaction Class

**Functional Description**:
`MySQLTransaction` is a class that provides a transaction for MySQL databases.

**Class Definition**:
```python
from databases.backends.mysql import MySQLTransaction
class MySQLTransaction(TransactionBackend):
    def __init__(self, connection: MySQLConnection):
        self._connection = connection
        self._is_root = False
        self._savepoint_name = ""

    async def start(
        self, is_root: bool, extra_options: typing.Dict[typing.Any, typing.Any]
    ) -> None:
        """
        Start the transaction.
        Returns None.
        """
    async def commit(self) -> None:
        """
        Commit the transaction.
        Returns None.
        """
    async def rollback(self) -> None:
        """
        Rollback the transaction.
        Returns None.
        """
```

#### 20. Row Class

**Functional Description**:
`Row` is a class that provides a row for database query results.

**Class Definition**:
```python
from databases.backends.common.records import Row
class Row(SQLRow):
    def __getitem__(self, key: typing.Any) -> typing.Any:
        """
        An instance of a Row in SQLAlchemy allows the access
        to the Row._fields as tuple and the Row._mapping for
        the values.
        """
        if isinstance(key, int):
            return super().__getitem__(key)

        idx = self._key_to_index[key][0]
        return super().__getitem__(idx)

    def keys(self):
        return self._mapping.keys()

    def values(self):
        return self._mapping.values()
```
#### 21. PGExecutionContext_psycopg Class

**Functional Description**:
`PGExecutionContext_psycopg` is a class that provides a execution context for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.dialects.psycopg import PGExecutionContext_psycopg


class PGExecutionContext_psycopg(PGExecutionContext):
    pass
```

#### 22. PGNumeric Class

**Functional Description**:
`PGNumeric` is a class that provides a numeric for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.dialects.psycopg import PGNumeric

class PGNumeric(Numeric):
    def bind_processor(
        self, dialect: typing.Any
    ) -> typing.Union[str, None]:  # pragma: no cover
        """
        Bind a processor to the numeric.
        Returns the processor.
        """

    def result_processor(
        self, dialect: typing.Any, coltype: typing.Any
    ) -> typing.Union[float, None]:  # pragma: no cover
        """
        Result a processor to the numeric.
        Returns the processor.
        """
```

#### 23. PGDialect_psycopg Class

**Functional Description**:
`PGDialect_psycopg` is a class that provides a dialect for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.dialects.psycopg import PGDialect_psycopg

class PGDialect_psycopg(PGDialect):
    colspecs = util.update_copy(
        PGDialect.colspecs,
        {
            types.Numeric: PGNumeric,
            types.Float: Float,
        },
    )
    execution_ctx_cls = PGExecutionContext_psycopg
```

#### 24. APGCompiler_psycopg2 Class

**Functional Description**:
`APGCompiler_psycopg2` is a class that provides a compiler for PostgreSQL databases.

**Class Definition**:
```python
from databases.backends.compilers.psycopg import APGCompiler_psycopg2

class APGCompiler_psycopg2(PGCompiler_psycopg):
    def construct_params(self, *args, **kwargs):
        """
        Construct parameters for the query.
        Returns the parameters.
        """
    def _exec_default(self, default):
        """
        Execute a default value.
        Returns the default value.
        """
```

#### 25. get_version Function

**Functional Description**:
`get_version` is a function that returns the version of the package.

**Function Signature**:
```python
def get_version(package):
```

**Parameter Description**:
- `package` (str): The package to get the version of

**Return Value**: The version of the package

#### 26. get_long_description Function

**Functional Description**:
`get_long_description` is a function that returns the long description of the package.

**Function Signature**:
```python
def get_long_description():
```

**Parameter Description**:
- None

**Return Value**: The long description of the package

#### 27. get_packages Function

**Functional Description**:
`get_packages` is a function that returns the packages of the project.

**Function Signature**:
```python
def get_packages(package):
```

**Parameter Description**:
- `package` (str): The package to get the packages of

**Return Value**: The packages of the project

#### 28. create_column_maps Function

**Functional Description**:
`create_column_maps` is a function that creates a column maps for the database.

**Function Signature**:
```python
from databases.backends.common.records import create_column_maps
def create_column_maps(result_columns: typing.Any) -> typing.Tuple[
    typing.Mapping[typing.Any, typing.Tuple[int, TypeEngine]],
    typing.Mapping[int, typing.Tuple[int, TypeEngine]],
    typing.Mapping[str, typing.Tuple[int, TypeEngine]]]:
```

**Parameter Description**:
- `result_columns` (typing.Any): The result columns to create the column maps for

**Return Value**: The column maps for the database

#### 29. _ACTIVE_TRANSACTIONS Constant
```python
from databases.core import _ACTIVE_TRANSACTIONS
_ACTIVE_TRANSACTIONS: ContextVar[
    typing.Optional["weakref.WeakKeyDictionary['Transaction', 'TransactionBackend']"]
] = ContextVar("databases:active_transactions", default=None)
```
#### 30. DIALECT_EXCLUDE Constant
**Import**: `from databases.backends.common.records import DIALECT_EXCLUDE`
**Function**: The constant for the dialects to exclude
**Value**: `{"postgresql"}`
**Type**: Constant


#### 31. __version__ Type Aliases
**File**: `databases\__init__.py`
**Value**: "0.9.0"

#### 32. __all__ Type Aliases
**File**: `databases\__init__.py`
**Value**: ["Database", "DatabaseURL"]

#### 33. ConnectionBackend Class - Connection Backend

**Function**: Manage a single database connection, providing query execution interfaces.

**Class Definition**:
```python
from databases.interfaces import ConnectionBackend
class ConnectionBackend:
    async def acquire(self) -> None:
        raise NotImplementedError()  # pragma: no cover

    async def release(self) -> None:
        raise NotImplementedError()  # pragma: no cover

    async def fetch_all(self, query: ClauseElement) -> typing.List["Record"]:
        raise NotImplementedError()  # pragma: no cover

    async def fetch_one(self, query: ClauseElement) -> typing.Optional["Record"]:
        raise NotImplementedError()  # pragma: no cover

    async def fetch_val(
        self, query: ClauseElement, column: typing.Any = 0
    ) -> typing.Any:
        row = await self.fetch_one(query)
        return None if row is None else row[column]

    async def execute(self, query: ClauseElement) -> typing.Any:
        raise NotImplementedError()  # pragma: no cover

    async def execute_many(self, queries: typing.List[ClauseElement]) -> None:
        raise NotImplementedError()  # pragma: no cover

    async def iterate(
        self, query: ClauseElement
    ) -> typing.AsyncGenerator[typing.Mapping, None]:
        raise NotImplementedError()  # pragma: no cover
        # mypy needs async iterators to contain a `yield`
        # https://github.com/python/mypy/issues/5385#issuecomment-407281656
        yield True  # pragma: no cover

    def transaction(self) -> "TransactionBackend":
        raise NotImplementedError()  # pragma: no cover

    @property
    def raw_connection(self) -> typing.Any:
        raise NotImplementedError()  # pragma: no cover

```

#### 34. TransactionBackend Class - Transaction Backend

**Function**: Manage a single database transaction, providing transaction execution interfaces.

**Class Definition**:
```python
from databases.interfaces import TransactionBackend
class TransactionBackend:
    async def start(
        self, is_root: bool, extra_options: typing.Dict[typing.Any, typing.Any]
    ) -> None:
        raise NotImplementedError()  # pragma: no cover

    async def commit(self) -> None:
        raise NotImplementedError()  # pragma: no cover

    async def rollback(self) -> None:
        raise NotImplementedError()  # pragma: no cover
```

#### 35. Record Class - Record

**Function**: Represent a single row of data in database query results, providing a dictionary-like interface to access column data and handling the conversion from database types to Python types.

**Class Definition**:
```python
from databases.interfaces import Record
class Record(Sequence):
    @property
    def _mapping(self) -> typing.Mapping:
        raise NotImplementedError()  # pragma: no cover

    def __getitem__(self, key: typing.Any) -> typing.Any:
        raise NotImplementedError()  # pragma: no cover
```
#### 36. AiopgTransaction class - PostgreSQL asynchronous transaction processing
**Function**: Manage asynchronous transaction operations for PostgreSQL database, supporting root transactions and savepoints
**Class Definition**:
```python
class AiopgTransaction(TransactionBackend):
    def __init__(connection: AiopgConnection) -> None
    async def start(is_root: bool, extra_options: typing.Dict[typing.Any, typing.Any]) -> None
    async def commit() -> None
    async def rollback() -> None
```
**Methods**:
  - __init__(connection)
    - **Function**: Initialize transaction instance with Aiopg connection
    - **Parameters**:
      - connection (AiopgConnection): Database connection instance
  - start(is_root, extra_options)
    - **Function**: Start transaction or create savepoint
    - **Parameters**:
      - is_root (bool): Whether it is a root transaction
      - extra_options (Dict[Any, Any]): Additional transaction options
    - **Raises**: AssertionError - If connection is not acquired
  - commit()
    - **Function**: Commit transaction or release savepoint
    - **Raises**: AssertionError - If connection is not acquired
  - rollback()
    - **Function**: Rollback transaction or rollback to savepoint
    - **Raises**: AssertionError - If connection is not acquired

#### 37. PostgresBackend class

**Function**: Provides an asynchronous PostgreSQL database backend implementation using asyncpg.

**Class Definition**:
```python
from databases.backends.postgres import PostgresBackend
class PostgresBackend(DatabaseBackend):
    def __init__(
        self, 
        database_url: typing.Union[DatabaseURL, str], 
        **options: typing.Any
    ) -> None
    
    def _get_dialect(self) -> Dialect
    def _get_connection_kwargs(self) -> dict
    async def connect(self) -> None
    async def disconnect(self) -> None
    def connection(self) -> "PostgresConnection"
```

**Methods**:

- `__init__(database_url, **options)`
  - **Function**: Initialize the PostgreSQL backend with database URL and options.
  - **Parameters**:
    - `database_url` (Union[DatabaseURL, str]): Database connection URL
    - `**options`: Additional connection options
  - **Return Value**: None

- `_get_dialect()`
  - **Function**: Get the SQLAlchemy dialect for PostgreSQL.
  - **Return Value**: Dialect - Configured SQLAlchemy dialect instance
  - **Note**: Internal method that configures PostgreSQL-specific dialect settings.

- `_get_connection_kwargs()`
  - **Function**: Extract and process connection parameters from the database URL.
  - **Return Value**: dict - Dictionary of connection parameters
  - **Note**: Internal method that processes URL options like min_size, max_size, and ssl.

- `connect()`
  - **Function**: Establish a connection pool to the PostgreSQL database.
  - **Raises**:
    - AssertionError: If the backend is already connected
  - **Return Value**: None
  - **Note**: Must be awaited and should be called before executing any queries.

- `disconnect()`
  - **Function**: Close all connections in the connection pool.
  - **Raises**:
    - AssertionError: If the backend is not connected
  - **Return Value**: None

- `connection()`
  - **Function**: Create a new database connection wrapper.
  - **Return Value**: PostgresConnection - A new connection instance
  - **Note**: The returned connection needs to be acquired before use.

#### 38. AsyncMyBackend class
**Function**: Provides an asynchronous MySQL database backend implementation based on asyncmy.

**Class Definition**:
```python
from databases.backends.asyncmy import AsyncMyBackend
class AsyncMyBackend(DatabaseBackend):
    def __init__(
        self, database_url: typing.Union[DatabaseURL, str], **options: typing.Any
    ) -> None:
        self._database_url = DatabaseURL(database_url)
        self._options = options
        self._dialect = pymysql.dialect(paramstyle="pyformat")
        self._dialect.supports_native_decimal = True
        self._pool = None
    
    def _get_connection_kwargs(self) -> dict
    async def connect(self) -> None
    async def disconnect(self) -> None
    def connection(self) -> "AsyncMyConnection"
```

**Methods**:

- `_get_connection_kwargs()`
  - **Function**: Extract and process connection parameters from the database URL.
  - **Processed Parameters**:
    - `min_size`: Minimum number of connections in the pool (mapped to 'minsize')
    - `max_size`: Maximum number of connections in the pool (mapped to 'maxsize')
    - `pool_recycle`: Connection recycle time (seconds)
    - `ssl`: SSL configuration
    - `unix_socket`: Unix socket path
  - **Return**: dict - Dictionary containing connection parameters

- `connect()`
  - **Function**: Establish a connection pool to the MySQL database.
  - **Parameters**: None
  - **Return**: None
  - **Exceptions**:
    - AssertionError: If the backend is already connected
  - **Note**: This method must be called before executing any queries.

- `disconnect()`
  - **Function**: Close all connections in the connection pool.
  - **Parameters**: None
  - **Return**: None
  - **Exceptions**:
    - AssertionError: If the backend is not running

- `connection()`
  - **Function**: Create a new database connection wrapper.
  - **Return**: AsyncMyConnection - New connection instance
  - **Note**: The returned connection needs to be acquired before use.


## Detailed Implementation Nodes

### Node 1: Database Connection Management (Database Connection Management)

**Description**: Manages the lifecycle of asynchronous database connections, including creation of connection pools, acquisition and release of connections, as well as connection isolation in multi-task environments. Supports unified connection interfaces for multiple database backends.

**Core Algorithm**:
- Asynchronous Connection Pool Management: Using `asyncpg`, `aiomysql` etc. asynchronous drivers to create connection pools
- Task-level Connection Isolation: Through `WeakKeyDictionary` for independent connections for each asynchronous task
- Connection Counter Management: Supports nested connection contexts, ensuring connections are released when the last context exits
- Automatic Connection Cleanup: Connections are automatically cleaned up during garbage collection

**Input/Output Example**:

```python
import asyncio
from databases import Database

async def test_connection_management():
    """Testing database connection management functionality"""
    # Create database instance
    database = Database("sqlite:///test.db")
    
    # Testing connection lifecycle
    assert not database.is_connected
    
    await database.connect()
    assert database.is_connected
    
    # Testing connection context management
    async with database.connection() as connection1:
        async with database.connection() as connection2:
            # Multiple connection contexts within the same task should return the same connection
            assert connection1 is connection2
            
            # Testing connection availability with query execution
            result = await connection1.fetch_one("SELECT 1 as value")
            assert result["value"] == 1
    
    await database.disconnect()
    assert not database.is_connected

# Testing multi-task connection isolation
async def test_task_isolation():
    """Testing connection isolation in multi-task environments"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    connection1 = None
    connection2 = None
    test_complete = asyncio.Event()
    
    async def task1():
        nonlocal connection1
        async with database.connection() as conn:
            connection1 = conn
            await test_complete.wait()
    
    async def task2():
        nonlocal connection2
        async with database.connection() as conn:
            connection2 = conn
            await test_complete.wait()
    
    # Creating two concurrent tasks
    task1_obj = asyncio.create_task(task1())
    task2_obj = asyncio.create_task(task2())
    
    # Waiting for connection establishment
    while connection1 is None or connection2 is None:
        await asyncio.sleep(0.001)
    
    # Verifying different tasks get different connections
    assert connection1 is not connection2
    
    test_complete.set()
    await task1_obj
    await task2_obj
    
    await database.disconnect()

# Running tests
if __name__ == "__main__":
    asyncio.run(test_connection_management())
    asyncio.run(test_task_isolation())
    print("Connection management test passed!")
```

**Testing Verification**:
```python
# Actual test cases from test_databases.py
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_connection_context_same_task(database_url):
    """Testing connection context management within the same task"""
    async with Database(database_url) as database:
        async with database.connection() as connection_1:
            async with database.connection() as connection_2:
                # Same task should return the same connection
                assert connection_1 is connection_2

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_connection_context_multiple_sibling_tasks(database_url):
    """Testing connection isolation between sibling tasks"""
    async with Database(database_url) as database:
        connection_1 = None
        connection_2 = None
        test_complete = asyncio.Event()

        async def get_connection_1():
            nonlocal connection_1
            async with database.connection() as connection:
                connection_1 = connection
                await test_complete.wait()

        async def get_connection_2():
            nonlocal connection_2
            async with database.connection() as connection:
                connection_2 = connection
                await test_complete.wait()

        task_1 = asyncio.create_task(get_connection_1())
        task_2 = asyncio.create_task(get_connection_2())
        
        while connection_1 is None or connection_2 is None:
            await asyncio.sleep(0.000001)
        
        # Different tasks should get different connections
        assert connection_1 is not connection_2
        
        test_complete.set()
        await task_1
        await task_2
```

### Node 2: Transaction Management (Transaction Management)

**Description**: Provides complete asynchronous transaction management functionality, supporting nested transactions, automatic commit/rollback, decorator patterns, and transaction isolation in multi-task environments. Ensure data consistency and ACID properties.

**Core Algorithm**:
- Transaction Stack Management: Using stack structure to manage nested transactions, supporting root transactions and sub-transactions
- Context Variable Transaction Tracking: Passing transaction state between asynchronous tasks through `ContextVar`
- Automatic Transaction Control: Rollback automatically on exception, commit automatically on normal exit
- Forced Rollback Mode: Supports forced rollback in testing environments to ensure test isolation

**Input/Output Example**:

```python
import asyncio
from databases import Database
import pytest

async def test_transaction_management():
    """Testing transaction management functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Testing basic transaction operations
    async with database.transaction(force_rollback=True) as transaction:
        # Insert data
        await database.execute(
            "CREATE TABLE IF NOT EXISTS test_table (id INTEGER, name TEXT)"
        )
        await database.execute(
            "INSERT INTO test_table (id, name) VALUES (?, ?)", 
            [1, "test1"]
        )
        
        # Verifying data insertion
        result = await database.fetch_one("SELECT * FROM test_table WHERE id = ?", [1])
        assert result["name"] == "test1"
    
    # Data should not exist after forced rollback
    result = await database.fetch_one("SELECT * FROM test_table WHERE id = ?", [1])
    assert result is None
    
    await database.disconnect()

# Testing nested transactions
async def test_nested_transactions():
    """Testing nested transaction management"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    async with database.transaction(force_rollback=True):
        # Creating test table
        await database.execute(
            "CREATE TABLE IF NOT EXISTS nested_test (id INTEGER, value TEXT)"
        )
        
        # Outer transaction
        async with database.transaction():
            await database.execute(
                "INSERT INTO nested_test (id, value) VALUES (?, ?)", 
                [1, "outer"]
            )
            
            # Inner transaction
            async with database.transaction():
                await database.execute(
                    "INSERT INTO nested_test (id, value) VALUES (?, ?)", 
                    [2, "inner"]
                )
                
                # Verifying visibility of inner transaction
                results = await database.fetch_all("SELECT * FROM nested_test ORDER BY id")
                assert len(results) == 2
                assert results[0]["value"] == "outer"
                assert results[1]["value"] == "inner"
    
    await database.disconnect()

# Testing transaction decorator
async def test_transaction_decorator():
    """Testing transaction decorator pattern"""
    database = Database("sqlite:///test.db", force_rollback=True)
    await database.connect()
    
    @database.transaction()
    async def insert_data(raise_exception=False):
        await database.execute(
            "CREATE TABLE IF NOT EXISTS decorator_test (id INTEGER, name TEXT)"
        )
        await database.execute(
            "INSERT INTO decorator_test (id, name) VALUES (?, ?)", 
            [1, "decorator_test"]
        )
        
        if raise_exception:
            raise RuntimeError("Test exception")
    
    # Testing normal commit
    await insert_data(raise_exception=False)
    result = await database.fetch_one("SELECT * FROM decorator_test WHERE id = ?", [1])
    assert result["name"] == "decorator_test"
    
    # Testing exception rollback
    with pytest.raises(RuntimeError):
        await insert_data(raise_exception=True)
    
    # Data should be rolled back after exception
    result = await database.fetch_one("SELECT * FROM decorator_test WHERE id = ?", [1])
    assert result is None
    
    await database.disconnect()

# Testing concurrent transaction isolation
async def test_concurrent_transactions():
    """Testing concurrent transaction isolation"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    await database.execute(
        "CREATE TABLE IF NOT EXISTS concurrent_test (id INTEGER, value TEXT)"
    )
    
    async def transaction_worker(task_id):
        async with database.transaction():
            await database.execute(
                "INSERT INTO concurrent_test (id, value) VALUES (?, ?)", 
                [task_id, f"task_{task_id}"]
            )
            # Simulating workload
            await asyncio.sleep(0.1)
    
    # Executing multiple transactions concurrently
    tasks = [transaction_worker(i) for i in range(5)]
    await asyncio.gather(*tasks)
    
    # Verifying all transactions are successfully committed
    results = await database.fetch_all("SELECT * FROM concurrent_test ORDER BY id")
    assert len(results) == 5
    
    # Cleaning up
    await database.execute("DELETE FROM concurrent_test")
    await database.disconnect()

# Running tests
if __name__ == "__main__":
    asyncio.run(test_transaction_management())
    asyncio.run(test_nested_transactions())
    asyncio.run(test_transaction_decorator())
    asyncio.run(test_concurrent_transactions())
    print("Transaction management test passed!")
```

**Testing Verification**:
```python
# Actual test cases from test_databases.py
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_transaction_commit(database_url):
    """Testing transaction commit functionality"""
    async with Database(database_url) as database:
        async with database.transaction(force_rollback=True):
            async with database.transaction():
                query = notes.insert().values(text="example1", completed=True)
                await database.execute(query)

            query = notes.select()
            results = await database.fetch_all(query=query)
            assert len(results) == 1

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_transaction_rollback(database_url):
    """Testing transaction rollback functionality"""
    async with Database(database_url) as database:
        async with database.transaction(force_rollback=True):
            try:
                async with database.transaction():
                    query = notes.insert().values(text="example1", completed=True)
                    await database.execute(query)
                    raise RuntimeError()
            except RuntimeError:
                pass

            query = notes.select()
            results = await database.fetch_all(query=query)
            assert len(results) == 0

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_transaction_decorator(database_url):
    """Testing transaction decorator"""
    database = Database(database_url, force_rollback=True)

    @database.transaction()
    async def insert_data(raise_exception):
        query = notes.insert().values(text="example", completed=True)
        await database.execute(query)
        if raise_exception:
            raise RuntimeError()

    async with database:
        with pytest.raises(RuntimeError):
            await insert_data(raise_exception=True)

        results = await database.fetch_all(query=notes.select())
        assert len(results) == 0

        await insert_data(raise_exception=False)

        results = await database.fetch_all(query=notes.select())
        assert len(results) == 1
```

### Node 3: Query Execution and Result Processing (Query Execution and Result Processing)

**Description**: Provides a unified asynchronous query execution interface, supporting raw SQL and SQLAlchemy Core queries, automatically handling parameter binding, type conversion, and result set encapsulation. Supports multiple query modes: single row, multiple rows, single value, iteration, etc.

**Core Algorithm**:
- Query Compilation and Parameter Binding: Automatically compile SQLAlchemy queries into raw SQL, supporting pre-compiled parameters
- Result Set Type Conversion: Automatically convert database types to Python types through the SQLAlchemy type system
- Record Object Encapsulation: Encapsulate raw database results into a Record object supporting mapping interfaces
- Asynchronous Iteration Support: Supports batch processing of large datasets and streaming iteration

**Input/Output Example**:

```python
import asyncio
from databases import Database
import sqlalchemy
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, DateTime, Date, Time, JSON, Numeric
from datetime import datetime, date, time
import decimal
import enum

async def test_query_execution():
    """Testing query execution functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table structure
    metadata = MetaData()
    
    notes = Table(
        "notes",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("text", String(100)),
        Column("completed", Boolean),
    )
    
    articles = Table(
        "articles",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("title", String(100)),
        Column("published", DateTime),
    )
    
    prices = Table(
        "prices",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("price", Numeric(precision=10, scale=2)),
    )
    
    # Creating tables
    for table in [notes, articles, prices]:
        await database.execute(sqlalchemy.schema.CreateTable(table))
    
    # Testing execute() - Inserting data
    await database.execute(notes.insert(), {"text": "example1", "completed": True})
    await database.execute(notes.insert(), {"text": "example2", "completed": False})
    
    # Testing execute_many() - Batch insert
    values = [
        {"text": "example3", "completed": True},
        {"text": "example4", "completed": False},
    ]
    await database.execute_many(notes.insert(), values)
    
    # Testing fetch_all() - Getting all results
    results = await database.fetch_all(notes.select())
    assert len(results) == 4
    assert results[0]["text"] == "example1"
    assert results[0]["completed"] == True
    
    # Testing fetch_one() - Getting a single row result
    result = await database.fetch_one(
        notes.select().where(notes.c.text == "example2")
    )
    assert result["text"] == "example2"
    assert result["completed"] == False
    
    # Testing fetch_val() - Getting a single value
    count = await database.fetch_val(
        sqlalchemy.select(sqlalchemy.func.count()).select_from(notes)
    )
    assert count == 4
    
    # Testing query with parameters
    completed_notes = await database.fetch_all(
        "SELECT * FROM notes WHERE completed = :completed",
        {"completed": True}
    )
    assert len(completed_notes) == 2
    
    # Testing SQLAlchemy Core Query
    query = notes.select().where(notes.c.completed == True)
    results = await database.fetch_all(query)
    assert len(results) == 2
    
    await database.disconnect()

# Testing data type handling
async def test_data_type_handling():
    """Testing handling of various data types"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Testing datetime type
    now = datetime.now().replace(microsecond=0)
    today = date.today()
    current_time = time(12, 30, 45)
    
    await database.execute(
        "INSERT INTO articles (title, published) VALUES (?, ?)",
        ["Test Article", now]
    )
    
    result = await database.fetch_one("SELECT * FROM articles WHERE title = ?", ["Test Article"])
    assert result["published"] == now
    
    # Testing numeric type
    price = decimal.Decimal("19.99")
    await database.execute(
        "INSERT INTO prices (price) VALUES (?)",
        [price]
    )
    
    result = await database.fetch_one("SELECT * FROM prices WHERE price = ?", [price])
    assert result["price"] == price
    
    # Testing boolean type
    result = await database.fetch_one(
        "SELECT * FROM notes WHERE completed = ?",
        [True]
    )
    assert result["completed"] == True
    
    await database.disconnect()

# Testing asynchronous iteration
async def test_async_iteration():
    """Testing asynchronous iteration functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Inserting test data
    for i in range(10):
        await database.execute(
            notes.insert(),
            {"text": f"iter_test_{i}", "completed": i % 2 == 0}
        )
    
    # Testing iterate() method
    iterate_results = []
    async for result in database.iterate("SELECT * FROM notes WHERE text LIKE 'iter_test_%' ORDER BY id"):
        iterate_results.append(result)
    
    assert len(iterate_results) == 10
    assert iterate_results[0]["text"] == "iter_test_0"
    assert iterate_results[9]["text"] == "iter_test_9"
    
    # Testing query with parameters
    iterate_results = []
    async for result in database.iterate(
        "SELECT * FROM notes WHERE completed = ? ORDER BY id",
        [True]
    ):
        iterate_results.append(result)
    
    assert len(iterate_results) == 5  # Records with even IDs
    
    await database.disconnect()

# Testing result set interface
async def test_result_interface():
    """Testing result set interface functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Inserting test data
    await database.execute(notes.insert(), {"text": "interface_test", "completed": True})
    
    # Testing mapping interface
    result = await database.fetch_one("SELECT * FROM notes WHERE text = ?", ["interface_test"])
    
    # Testing dictionary-style access
    assert result["text"] == "interface_test"
    assert result["completed"] == True
    
    # Testing attribute-style access
    assert result.text == "interface_test"
    assert result.completed == True
    
    # Testing index access
    assert result[1] == "interface_test"  # text column
    assert result[2] == True              # completed column
    
    # Testing key-value pairs
    keys = list(result.keys())
    values = list(result.values())
    assert "text" in keys
    assert "completed" in keys
    assert "interface_test" in values
    assert True in values
    
    # Testing length
    assert len(result) == 3  # id, text, completed
    
    await database.disconnect()

# Running tests
if __name__ == "__main__":
    asyncio.run(test_query_execution())
    asyncio.run(test_data_type_handling())
    asyncio.run(test_async_iteration())
    asyncio.run(test_result_interface())
    print("Query execution and result processing test passed!")
```

**Testing Verification**:
```python
# Actual test cases from test_databases.py
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_queries(database_url):
    """Testing basic query interface"""
    async with Database(database_url) as database:
        async with database.transaction(force_rollback=True):
            # execute()
            query = notes.insert()
            values = {"text": "example1", "completed": True}
            await database.execute(query, values)

            # execute_many()
            query = notes.insert()
            values = [
                {"text": "example2", "completed": False},
                {"text": "example3", "completed": True},
            ]
            await database.execute_many(query, values)

            # fetch_all()
            query = notes.select()
            results = await database.fetch_all(query=query)
            assert len(results) == 3
            assert results[0]["text"] == "example1"
            assert results[0]["completed"] == True

            # fetch_one()
            query = notes.select()
            result = await database.fetch_one(query=query)
            assert result["text"] == "example1"
            assert result["completed"] == True

            # fetch_val()
            query = sqlalchemy.sql.select(*[notes.c.text])
            result = await database.fetch_val(query=query)
            assert result == "example1"

            # iterate()
            query = notes.select()
            iterate_results = []
            async for result in database.iterate(query=query):
                iterate_results.append(result)
            assert len(iterate_results) == 3

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_results_support_mapping_interface(database_url):
    """Testing result set mapping interface"""
    async with Database(database_url) as database:
        async with database.transaction(force_rollback=True):
            await database.execute(notes.insert(), {"text": "example1", "completed": True})
            
            results = await database.fetch_all(notes.select())
            results_as_dicts = [dict(item) for item in results]
            
            assert len(results[0]) == 3
            assert len(results_as_dicts[0]) == 3
            assert isinstance(results_as_dicts[0]["id"], int)
            assert results_as_dicts[0]["text"] == "example1"
            assert results_as_dicts[0]["completed"] == True
```

### Node 4: Database Backend Abstraction and Driver Integration (Database Backend Abstraction and Driver Integration)

**Description**: Provides a unified database backend abstraction interface, supporting seamless integration of multiple database drivers, including PostgreSQL, MySQL, SQLite, etc. Achieve database-agnostic code writing through the abstraction layer.

**Core Algorithm**:
- Backend Factory Pattern: Automatically select the appropriate backend implementation based on the database URL
- Driver Adapter: Unify API differences across different drivers, providing a consistent interface
- Dialect Support: Handle SQL syntax differences and type mappings across different databases
- Connection Pool Management: Provide optimized connection pool configuration for each database type

**Input/Output Example**:

```python
import asyncio
from databases import Database, DatabaseURL
from databases.backends.postgres import PostgresBackend
from databases.backends.mysql import MySQLBackend
from databases.backends.sqlite import SQLiteBackend

async def test_backend_abstraction():
    """Testing database backend abstraction functionality"""
    
    # Testing PostgreSQL backend
    postgres_db = Database("postgresql://user:pass@localhost/testdb")
    assert isinstance(postgres_db._backend, PostgresBackend)
    
    # Testing MySQL backend
    mysql_db = Database("mysql://user:pass@localhost/testdb")
    assert isinstance(mysql_db._backend, MySQLBackend)
    
    # Testing SQLite backend
    sqlite_db = Database("sqlite:///test.db")
    assert isinstance(sqlite_db._backend, SQLiteBackend)
    
    # Testing URL with driver
    aiopg_db = Database("postgresql+aiopg://user:pass@localhost/testdb")
    assert isinstance(aiopg_db._backend, PostgresBackend)
    
    asyncmy_db = Database("mysql+asyncmy://user:pass@localhost/testdb")
    assert isinstance(asyncmy_db._backend, MySQLBackend)

# Testing database URL parsing
async def test_database_url_parsing():
    """Testing database URL parsing functionality"""
    
    # Testing standard PostgreSQL URL
    url = DatabaseURL("postgresql://user:password@localhost:5432/mydb?sslmode=require")
    assert url.scheme == "postgresql"
    assert url.username == "user"
    assert url.password == "password"
    assert url.hostname == "localhost"
    assert url.port == 5432
    assert url.database == "mydb"
    assert url.options["sslmode"] == "require"
    
    # Testing MySQL URL
    url = DatabaseURL("mysql://user:pass@localhost/mydb?charset=utf8mb4")
    assert url.scheme == "mysql"
    assert url.username == "user"
    assert url.hostname == "localhost"
    assert url.database == "mydb"
    assert url.options["charset"] == "utf8mb4"
    
    # Testing SQLite URL
    url = DatabaseURL("sqlite:///path/to/database.db")
    assert url.scheme == "sqlite"
    assert url.database == "path/to/database.db"
    
    # Testing URL replacement functionality
    new_url = url.replace(database="new_database.db")
    assert new_url.database == "new_database.db"
    assert str(new_url) == "sqlite:///new_database.db"

# Testing backend-specific features
async def test_backend_specific_features():
    """Testing backend-specific features"""
    
    # PostgreSQL-specific features
    postgres_db = Database("postgresql://user:pass@localhost/testdb")
    
    # Testing JSON support in PostgreSQL
    async with postgres_db:
        await postgres_db.execute("""
            CREATE TABLE IF NOT EXISTS json_test (
                id SERIAL PRIMARY KEY,
                data JSONB
            )
        """)
        
        # Inserting JSON data
        await postgres_db.execute(
            "INSERT INTO json_test (data) VALUES (:data)",
            {"data": {"key": "value", "nested": {"array": [1, 2, 3]}}}
        )
        
        # Querying JSON data
        result = await postgres_db.fetch_one(
            "SELECT data->>'key' as key_value FROM json_test WHERE id = 1"
        )
        assert result["key_value"] == "value"
    
    # MySQL-specific features
    mysql_db = Database("mysql://user:pass@localhost/testdb")
    
    async with mysql_db:
        # Testing JSON support in MySQL
        await mysql_db.execute("""
            CREATE TABLE IF NOT EXISTS json_test (
                id INT AUTO_INCREMENT PRIMARY KEY,
                data JSON
            )
        """)
        
        # Inserting JSON data
        await mysql_db.execute(
            "INSERT INTO json_test (data) VALUES (:data)",
            {"data": '{"key": "value", "nested": {"array": [1, 2, 3]}}'}
        )
        
        # Querying JSON data
        result = await mysql_db.fetch_one(
            "SELECT JSON_EXTRACT(data, '$.key') as key_value FROM json_test WHERE id = 1"
        )
        assert result["key_value"] == "value"

# Testing connection pool configuration
async def test_connection_pool_config():
    """Testing connection pool configuration functionality"""
    
    # Testing PostgreSQL connection pool configuration
    postgres_db = Database(
        "postgresql://user:pass@localhost/testdb?min_size=5&max_size=20&ssl=true"
    )
    
    url = postgres_db.url
    assert url.options["min_size"] == "5"
    assert url.options["max_size"] == "20"
    assert url.options["ssl"] == "true"
    
    # Testing MySQL connection pool configuration
    mysql_db = Database(
        "mysql://user:pass@localhost/testdb?charset=utf8mb4&autocommit=false"
    )
    
    url = mysql_db.url
    assert url.options["charset"] == "utf8mb4"
    assert url.options["autocommit"] == "false"

# Testing dialect support
async def test_dialect_support():
    """Testing SQL dialect support"""
    
    # Testing PostgreSQL dialect
    postgres_db = Database("postgresql://user:pass@localhost/testdb")
    
    # PostgreSQL uses $1, $2 placeholders
    async with postgres_db:
        await postgres_db.execute(
            "CREATE TABLE IF NOT EXISTS dialect_test (id INT, name TEXT)"
        )
        
        # Using PostgreSQL-style parameters
        await postgres_db.execute(
            "INSERT INTO dialect_test (id, name) VALUES ($1, $2)",
            [1, "test"]
        )
    
    # Testing MySQL dialect
    mysql_db = Database("mysql://user:pass@localhost/testdb")
    
    async with mysql_db:
        await mysql_db.execute(
            "CREATE TABLE IF NOT EXISTS dialect_test (id INT, name VARCHAR(100))"
        )
        
        # Using MySQL-style parameters
        await mysql_db.execute(
            "INSERT INTO dialect_test (id, name) VALUES (%s, %s)",
            [1, "test"]
        )

# Running tests
if __name__ == "__main__":
    asyncio.run(test_backend_abstraction())
    asyncio.run(test_database_url_parsing())
    asyncio.run(test_backend_specific_features())
    asyncio.run(test_connection_pool_config())
    asyncio.run(test_dialect_support())
    print("Database backend abstraction and driver integration test passed!")
```

**Testing Verification**:
```python
# Actual test cases from test_databases.py
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_database_url_interface(database_url):
    """Testing database URL interface"""
    async with Database(database_url) as database:
        assert isinstance(database.url, DatabaseURL)
        assert database.url == database_url

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_queries_with_expose_backend_connection(database_url):
    """Testing backend connection exposure"""
    async with Database(database_url) as database:
        async with database.connection() as connection:
            async with connection.transaction(force_rollback=True):
                # Getting raw connection
                raw_connection = connection.raw_connection
                
                # Executing different queries based on database type
                if database.url.scheme in ["mysql", "mysql+asyncmy", "mysql+aiomysql"]:
                    insert_query = "INSERT INTO notes (text, completed) VALUES (%s, %s)"
                else:
                    insert_query = "INSERT INTO notes (text, completed) VALUES ($1, $2)"
                
                values = ("example1", True)
                
                # Using raw connection to execute query
                if database.url.scheme in ["mysql", "mysql+asyncmy", "mysql+aiomysql"]:
                    cursor = await raw_connection.cursor()
                    await cursor.execute(insert_query, values)
                elif database.url.scheme in ["postgresql", "postgresql+asyncpg"]:
                    await raw_connection.execute(insert_query, *values)
                elif database.url.scheme in ["sqlite", "sqlite+aiosqlite"]:
                    await raw_connection.execute(insert_query, values)
                
                # Verifying insertion result
                result = await database.fetch_one("SELECT * FROM notes WHERE text = ?", ["example1"])
                assert result["text"] == "example1"
                assert result["completed"] == True

# Testing specific features of different databases
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_database_specific_features(database_url):
    """Testing specific features of databases"""
    database_url_obj = DatabaseURL(database_url)
    
    if database_url_obj.scheme in ["postgresql", "postgresql+asyncpg"]:
        # Specific tests for PostgreSQL
        async with Database(database_url) as database:
            async with database.transaction(force_rollback=True):
                # Testing JSONB type in PostgreSQL
                await database.execute("""
                    CREATE TABLE IF NOT EXISTS json_test (
                        id SERIAL PRIMARY KEY,
                        data JSONB
                    )
                """)
                
                await database.execute(
                    "INSERT INTO json_test (data) VALUES (:data)",
                    {"data": {"key": "value"}}
                )
                
                result = await database.fetch_one("SELECT data->>'key' as value FROM json_test")
                assert result["value"] == "value"
    
    elif database_url_obj.scheme in ["mysql", "mysql+asyncmy", "mysql+aiomysql"]:
        # Specific tests for MySQL
        async with Database(database_url) as database:
            async with database.transaction(force_rollback=True):
                # Testing JSON type in MySQL
                await database.execute("""
                    CREATE TABLE IF NOT EXISTS json_test (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        data JSON
                    )
                """)
                
                await database.execute(
                    "INSERT INTO json_test (data) VALUES (:data)",
                    {"data": '{"key": "value"}'}
                )
                
                result = await database.fetch_one("SELECT JSON_EXTRACT(data, '$.key') as value FROM json_test")
                assert result["value"] == "value"
```

### Node 5: Data Type Handling and Type Safety (Data Type Handling and Type Safety)

**Description**: Provides complete Python data type to database type mapping, supporting automatic type conversion, type validation, and type-safe query building. Ensure data consistency and security through the SQLAlchemy type system, supporting complex data types such as JSON, datetime, numeric, etc.

**Core Algorithm**:
- Type Mapping Table: Establish mapping between Python types and database types
- Automatic Type Conversion: Automatically convert data types during query execution
- Type Validation: Validate data types during insertion and updating
- Type Inference: Automatically infer data types for columns based on table structure

**Input/Output Example**:

```python
import asyncio
from databases import Database
import sqlalchemy
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, DateTime, Date, Time, JSON, Numeric, Text, Float
from datetime import datetime, date, time
import decimal
import json
from typing import Any, Dict, List

async def test_data_type_handling():
    """Testing data type handling functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table with various data types
    metadata = MetaData()
    
    type_test_table = Table(
        "type_test",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("text_col", String(100)),
        Column("bool_col", Boolean),
        Column("int_col", Integer),
        Column("float_col", Float),
        Column("decimal_col", Numeric(precision=10, scale=2)),
        Column("date_col", Date),
        Column("time_col", Time),
        Column("datetime_col", DateTime),
        Column("json_col", JSON),
        Column("text_long", Text),
    )
    
    # Creating table
    await database.execute(sqlalchemy.schema.CreateTable(type_test_table))
    
    # Testing insertion of various data types
    test_data = {
        "text_col": "Hello World",
        "bool_col": True,
        "int_col": 42,
        "float_col": 3.14159,
        "decimal_col": decimal.Decimal("123.45"),
        "date_col": date(2024, 1, 15),
        "time_col": time(14, 30, 45),
        "datetime_col": datetime(2024, 1, 15, 14, 30, 45),
        "json_col": {"key": "value", "nested": {"array": [1, 2, 3]}},
        "text_long": "This is a very long text that exceeds the normal string limit",
    }
    
    # Inserting test data
    await database.execute(type_test_table.insert(), test_data)
    
    # Querying and verifying data types
    result = await database.fetch_one("SELECT * FROM type_test WHERE id = 1")
    
    # Verifying correctness of various data types
    assert result["text_col"] == "Hello World"
    assert result["bool_col"] == True
    assert result["int_col"] == 42
    assert result["float_col"] == 3.14159
    assert result["decimal_col"] == decimal.Decimal("123.45")
    assert result["date_col"] == date(2024, 1, 15)
    assert result["time_col"] == time(14, 30, 45)
    assert result["datetime_col"] == datetime(2024, 1, 15, 14, 30, 45)
    assert result["json_col"] == {"key": "value", "nested": {"array": [1, 2, 3]}}
    assert result["text_long"] == "This is a very long text that exceeds the normal string limit"
    
    # Verifying type information
    assert isinstance(result["bool_col"], bool)
    assert isinstance(result["int_col"], int)
    assert isinstance(result["float_col"], float)
    assert isinstance(result["decimal_col"], decimal.Decimal)
    assert isinstance(result["date_col"], date)
    assert isinstance(result["time_col"], time)
    assert isinstance(result["datetime_col"], datetime)
    assert isinstance(result["json_col"], dict)
    
    await database.disconnect()

# Testing type conversion and validation
async def test_type_conversion():
    """Testing type conversion functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    await database.execute("""
        CREATE TABLE IF NOT EXISTS conversion_test (
            id INTEGER PRIMARY KEY,
            int_col INTEGER,
            float_col REAL,
            text_col TEXT,
            bool_col INTEGER
        )
    """)
    
    # Testing automatic conversion of Python types to database types
    test_data = {
        "int_col": "123",      # String to integer
        "float_col": "3.14",   # String to float
        "text_col": 456,       # Integer to string
        "bool_col": True,      # Boolean to integer
    }
    
    await database.execute(
        "INSERT INTO conversion_test (int_col, float_col, text_col, bool_col) VALUES (?, ?, ?, ?)",
        [test_data["int_col"], test_data["float_col"], test_data["text_col"], test_data["bool_col"]]
    )
    
    # Querying results
    result = await database.fetch_one("SELECT * FROM conversion_test WHERE id = 1")
    
    # Verifying type conversion results
    assert result["int_col"] == 123
    assert result["float_col"] == 3.14
    assert result["text_col"] == "456"
    assert result["bool_col"] == 1  # True in SQLite is converted to 1
    
    await database.disconnect()

# Testing type-safe query building
async def test_type_safe_queries():
    """Testing type-safe query building"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    metadata = MetaData()
    
    users = Table(
        "users",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("name", String(100)),
        Column("age", Integer),
        Column("active", Boolean),
        Column("score", Float),
    )
    
    await database.execute(sqlalchemy.schema.CreateTable(users))
    
    # Inserting test data
    await database.execute_many(users.insert(), [
        {"name": "Alice", "age": 25, "active": True, "score": 95.5},
        {"name": "Bob", "age": 30, "active": False, "score": 87.2},
        {"name": "Charlie", "age": 35, "active": True, "score": 92.8},
    ])
    
    # Using SQLAlchemy Core to build type-safe queries
    # Type-safe WHERE conditions
    query = users.select().where(
        users.c.age >= 25,
        users.c.active == True,
        users.c.score > 90.0
    )
    
    results = await database.fetch_all(query)
    
    # Verifying query results
    assert len(results) == 2  # Alice and Charlie
    assert results[0]["name"] == "Alice"
    assert results[1]["name"] == "Charlie"
    
    # Testing type safety of parameterized queries
    age_threshold = 30
    score_threshold = 90.0
    
    param_query = users.select().where(
        users.c.age >= age_threshold,
        users.c.score >= score_threshold
    )
    
    param_results = await database.fetch_all(param_query)
    assert len(param_results) == 1  # Only Charlie
    
    await database.disconnect()

# Testing handling of complex data types
async def test_complex_data_types():
    """Testing handling of complex data types"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    await database.execute("""
        CREATE TABLE IF NOT EXISTS complex_types (
            id INTEGER PRIMARY KEY,
            json_data JSON,
            array_data TEXT,  -- SQLite does not support arrays, using TEXT instead
            enum_data TEXT    -- Simulating an enum type
        )
    """)
    
    # Testing JSON data type
    complex_json = {
        "user": {
            "name": "John Doe",
            "email": "john@example.com",
            "preferences": {
                "theme": "dark",
                "notifications": True,
                "languages": ["en", "es", "fr"]
            }
        },
        "metadata": {
            "created_at": "2024-01-15T10:30:00Z",
            "version": "1.0.0",
            "tags": ["user", "premium"]
        }
    }
    
    # Inserting complex data
    await database.execute(
        "INSERT INTO complex_types (json_data, array_data, enum_data) VALUES (?, ?, ?)",
        [json.dumps(complex_json), "item1,item2,item3", "ACTIVE"]
    )
    
    # Querying JSON data
    result = await database.fetch_one("SELECT * FROM complex_types WHERE id = 1")
    
    # Verifying JSON data
    retrieved_json = json.loads(result["json_data"])
    assert retrieved_json["user"]["name"] == "John Doe"
    assert retrieved_json["user"]["preferences"]["theme"] == "dark"
    assert retrieved_json["metadata"]["tags"] == ["user", "premium"]
    
    # Verifying other data types
    assert result["array_data"] == "item1,item2,item3"
    assert result["enum_data"] == "ACTIVE"
    
    await database.disconnect()

# Testing error handling for incorrect types
async def test_type_error_handling():
    """Testing error handling for incorrect types"""
    database = Database("sqlite:///test.db")
    await database.disconnect()
    
    # Testing invalid database connection
    try:
        await database.execute("SELECT 1")
        assert False, "An exception should be raised"
    except Exception as e:
        assert "not connected" in str(e).lower() or "connection" in str(e).lower()
    
    # Testing query parameter type mismatch
    database = Database("sqlite:///test.db")
    await database.connect()
    
    try:
        # Trying to insert invalid date format
        await database.execute(
            "INSERT INTO type_test (date_col) VALUES (?)",
            ["invalid-date"]
        )
        # SQLite might not raise an exception, but it will insert NULL
        result = await database.fetch_one("SELECT date_col FROM type_test WHERE date_col IS NULL")
        assert result is not None
    except Exception as e:
        # Some databases might raise type errors
        print(f"Type error: {e}")
    
    await database.disconnect()

# Running tests
if __name__ == "__main__":
    asyncio.run(test_data_type_handling())
    asyncio.run(test_type_conversion())
    asyncio.run(test_type_safe_queries())
    asyncio.run(test_complex_data_types())
    asyncio.run(test_type_error_handling())
    print("Data type handling and type safety test passed!")
```

**Testing Verification**:
```python
# Actual test cases from test_databases.py
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_data_types(database_url):
    """Testing handling of various data types"""
    async with Database(database_url) as database:
        async with database.transaction(force_rollback=True):
            # Creating test table
            await database.execute("""
                CREATE TABLE IF NOT EXISTS data_types_test (
                    id INTEGER PRIMARY KEY,
                    text_col TEXT,
                    int_col INTEGER,
                    float_col REAL,
                    bool_col INTEGER,
                    date_col TEXT,
                    json_col TEXT
                )
            """)
            
            # Inserting various types of data
            test_data = {
                "text_col": "Hello World",
                "int_col": 42,
                "float_col": 3.14159,
                "bool_col": True,
                "date_col": "2024-01-15",
                "json_col": '{"key": "value"}'
            }
            
            await database.execute(
                "INSERT INTO data_types_test (text_col, int_col, float_col, bool_col, date_col, json_col) VALUES (?, ?, ?, ?, ?, ?)",
                list(test_data.values())
            )
            
            # Querying and verifying data types
            result = await database.fetch_one("SELECT * FROM data_types_test WHERE id = 1")
            
            assert result["text_col"] == "Hello World"
            assert result["int_col"] == 42
            assert result["float_col"] == 3.14159
            assert result["bool_col"] == 1  # True in SQLite is converted to 1
            assert result["date_col"] == "2024-01-15"
            assert result["json_col"] == '{"key": "value"}'

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_type_conversion_errors(database_url):
    """Testing error handling for incorrect type conversions"""
    async with Database(database_url) as database:
        async with database.transaction(force_rollback=True):
            # Creating test table
            await database.execute("""
                CREATE TABLE IF NOT EXISTS conversion_test (
                    id INTEGER PRIMARY KEY,
                    int_col INTEGER
                )
            """)
            
            # Testing invalid integer conversion
            try:
                await database.execute(
                    "INSERT INTO conversion_test (int_col) VALUES (?)",
                    ["not_a_number"]
                )
                # SQLite might not raise an exception, but it will insert NULL
                result = await database.fetch_one("SELECT int_col FROM conversion_test WHERE int_col IS NULL")
                assert result is not None
            except Exception as e:
                # Some databases might raise type errors
                assert "type" in str(e).lower() or "conversion" in str(e).lower()
```

### Node 6: Web Framework Integration and Middleware Support (Web Framework Integration and Middleware Support)

**Description**: Provides seamless integration with mainstream web frameworks, supporting FastAPI, Starlette and other ASGI frameworks, including database middleware, dependency injection, connection lifecycle management, etc. Implement database best practices in web applications.

**Core Algorithm**:
- Middleware Integration: Manage database connection lifecycle through ASGI middleware
- Dependency Injection: Integrate with FastAPI's dependency injection system
- Connection Pool Management: Reuse database connections within web requests
- Transaction Management: Automatically handle transaction boundaries within web requests

**Input/Output Example**:

```python
import asyncio
from databases import Database
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import FastAPI, Depends
from contextlib import asynccontextmanager

# Testing Starlette integration
async def test_starlette_integration():
    """Testing Starlette framework integration"""
    
    # Creating database instance
    database = Database("sqlite:///test.db")
    
    # Creating Starlette application
    app = Starlette()
    
    # Adding startup and shutdown events
    @app.on_event("startup")
    async def startup():
        await database.connect()
    
    @app.on_event("shutdown")
    async def shutdown():
        await database.disconnect()
    
    # Defining routes
    async def get_users(request: Request):
        query = "SELECT * FROM users LIMIT 10"
        results = await database.fetch_all(query)
        return JSONResponse({"users": [dict(user) for user in results]})
    
    async def create_user(request: Request):
        data = await request.json()
        query = "INSERT INTO users (name, email) VALUES (:name, :email)"
        await database.execute(query, data)
        return JSONResponse({"message": "User created"})
    
    # Adding routes
    app.add_route("/users", get_users, methods=["GET"])
    app.add_route("/users", create_user, methods=["POST"])
    
    # Testing application startup and shutdown
    assert not database.is_connected
    
    # Simulating startup event
    await startup()
    assert database.is_connected
    
    # Simulating shutdown event
    await shutdown()
    assert not database.is_connected

# Testing FastAPI integration
async def test_fastapi_integration():
    """Testing FastAPI framework integration"""
    
    # Creating database instance
    database = Database("sqlite:///test.db")
    
    # Creating FastAPI application
    app = FastAPI()
    
    # Database dependency
    async def get_database():
        return database
    
    # User model
    class User:
        def __init__(self, id: int, name: str, email: str):
            self.id = id
            self.name = name
            self.email = email
    
    # User service
    class UserService:
        def __init__(self, db: Database):
            self.db = db
        
        async def get_users(self):
            query = "SELECT * FROM users"
            results = await self.db.fetch_all(query)
            return [User(**dict(user)) for user in results]
        
        async def create_user(self, name: str, email: str):
            query = "INSERT INTO users (name, email) VALUES (:name, :email)"
            await self.db.execute(query, {"name": name, "email": email})
            return {"message": "User created"}
    
    # Dependency injection
    async def get_user_service(db: Database = Depends(get_database)):
        return UserService(db)
    
    # Route definition
    @app.get("/users")
    async def get_users(service: UserService = Depends(get_user_service)):
        users = await service.get_users()
        return {"users": [{"id": u.id, "name": u.name, "email": u.email} for u in users]}
    
    @app.post("/users")
    async def create_user(
        name: str,
        email: str,
        service: UserService = Depends(get_user_service)
    ):
        return await service.create_user(name, email)
    
    # Testing dependency injection
    db = await get_database()
    service = await get_user_service(db)
    
    # Testing user service
    await service.create_user("John Doe", "john@example.com")
    users = await service.get_users()
    assert len(users) > 0
    assert users[0].name == "John Doe"

# Testing database middleware
class DatabaseMiddleware(BaseHTTPMiddleware):
    """Database middleware, managing connection lifecycle"""
    
    def __init__(self, app, database: Database):
        super().__init__(app)
        self.database = database
    
    async def dispatch(self, request: Request, call_next):
        # Ensuring database connection
        if not self.database.is_connected:
            await self.database.connect()
        
        try:
            response = await call_next(request)
            return response
        finally:
            # Connection is not closed after request, keeping connection pool
            pass

async def test_database_middleware():
    """Testing database middleware"""
    
    database = Database("sqlite:///test.db")
    
    # Creating application
    app = Starlette()
    
    # Adding middleware
    app.add_middleware(DatabaseMiddleware, database=database)
    
    # Testing middleware functionality
    assert not database.is_connected
    
    # Simulating request
    request = Request({"type": "http", "method": "GET", "path": "/"})
    
    # Middleware should automatically connect to database
    middleware = DatabaseMiddleware(app, database)
    await middleware.dispatch(request, lambda req: None)
    
    # Verifying connection status
    assert database.is_connected

# Testing connection pool management
async def test_connection_pool_management():
    """Testing connection pool management"""
    
    database = Database(
        "sqlite:///test.db?min_size=2&max_size=10"
    )
    
    await database.connect()
    
    # Testing connection pool configuration
    assert database.is_connected
    
    # Simulating multiple concurrent requests
    async def concurrent_request(request_id: int):
        async with database.connection() as connection:
            # Executing query
            result = await connection.fetch_one("SELECT 1 as value")
            assert result["value"] == 1
            return f"Request {request_id} completed"
    
    # Executing multiple requests concurrently
    tasks = [concurrent_request(i) for i in range(5)]
    results = await asyncio.gather(*tasks)
    
    assert len(results) == 5
    assert all("completed" in result for result in results)
    
    await database.disconnect()

# Testing transaction management integration
async def test_transaction_integration():
    """Testing transaction management integration"""
    
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    await database.execute("""
        CREATE TABLE IF NOT EXISTS web_users (
            id INTEGER PRIMARY KEY,
            name TEXT,
            email TEXT
        )
    """)
    
    # Simulating transaction management within web requests
    async def web_request_handler():
        try:
            async with database.transaction():
                # Inserting user
                await database.execute(
                    "INSERT INTO web_users (name, email) VALUES (?, ?)",
                    ["Alice", "alice@example.com"]
                )
                
                # Querying user
                result = await database.fetch_one(
                    "SELECT * FROM web_users WHERE name = ?",
                    ["Alice"]
                )
                
                assert result["name"] == "Alice"
                assert result["email"] == "alice@example.com"
                
                # Transaction should automatically commit
                return "Success"
                
        except Exception as e:
            # Transaction should automatically roll back
            return f"Error: {str(e)}"
    
    # Executing web request processing
    result = await web_request_handler()
    assert result == "Success"
    
    # Verifying data has been committed
    final_result = await database.fetch_one(
        "SELECT * FROM web_users WHERE name = ?",
        ["Alice"]
    )
    assert final_result is not None
    
    await database.disconnect()

# Running tests
if __name__ == "__main__":
    asyncio.run(test_starlette_integration())
    asyncio.run(test_fastapi_integration())
    asyncio.run(test_database_middleware())
    asyncio.run(test_connection_pool_management())
    asyncio.run(test_transaction_integration())
    print("Web framework integration and middleware support test passed!")
```

**Testing Verification**:
```python
# Actual test cases from test_integration.py
@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_starlette_integration(database_url):
    """Testing Starlette integration"""
    database = Database(database_url)
    
    # Creating Starlette application
    app = Starlette()
    
    @app.on_event("startup")
    async def startup():
        await database.connect()
    
    @app.on_event("shutdown")
    async def shutdown():
        await database.disconnect()
    
    # Testing startup and shutdown events
    await startup()
    assert database.is_connected
    
    await shutdown()
    assert not database.is_connected

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_fastapi_dependency_injection(database_url):
    """Testing FastAPI dependency injection"""
    database = Database(database_url)
    
    # Database dependency
    async def get_database():
        return database
    
    # User service
    class UserService:
        def __init__(self, db: Database):
            self.db = db
        
        async def get_user_count(self):
            result = await self.db.fetch_val("SELECT COUNT(*) FROM users")
            return result
    
    # Dependency injection test
    db = await get_database()
    service = UserService(db)
    
    # Testing service functionality
    count = await service.get_user_count()
    assert isinstance(count, int)

@pytest.mark.parametrize("database_url", DATABASE_URLS)
@async_adapter
async def test_connection_lifecycle_in_web_context(database_url):
    """Testing connection lifecycle within web context"""
    database = Database(database_url)
    
    async with database:
        # Simulating web request
        async with database.connection() as connection:
            # Executing query
            result = await connection.fetch_one("SELECT 1 as value")
            assert result["value"] == 1
            
            # Connection should be automatically released at the end of the request
            assert connection.is_connected
    
    # Database should be disconnected when the application is closed
    assert not database.is_connected

```

### Node 7: Connection Pool Management and Task Isolation (Connection Pool Management and Task Isolation)

**Description**:
Databases implements an asyncio.Task-based connection pool management mechanism, ensuring each asynchronous task has independent database connections, supporting connection reuse and automatic release.

**Core Algorithm**:
- Using `weakref.WeakKeyDictionary` to implement task-to-connection mapping
- Managing connection status for each task through `_connection_map`
- Implementing connection counter and automatic connection acquisition/release mechanism
- Supporting `force_rollback` mode for testing environments

**Input/Output Example**:

```python
import asyncio
from databases import Database
import sqlalchemy
from sqlalchemy import MetaData, Table, Column, Integer, String

async def test_connection_pool_management():
    """Testing connection pool management functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    metadata = MetaData()
    notes = Table(
        "notes",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("text", String(100)),
    )
    
    # Testing task isolation - each task has separate connection
    async def task1():
        async with database.connection() as conn:
            await conn.execute(notes.insert(), {"text": "task1"})
            result = await conn.fetch_one(notes.select())
            return result["text"]
    
    async def task2():
        async with database.connection() as conn:
            await conn.execute(notes.insert(), {"text": "task2"})
            result = await conn.fetch_one(notes.select())
            return result["text"]
    
    # Executing tasks concurrently
    results = await asyncio.gather(task1(), task2())
    assert results == ["task1", "task2"]
    
    # Testing force_rollback mode
    with database.force_rollback():
        async with database.transaction():
            await database.execute(notes.insert(), {"text": "test"})
            # This insertion will be automatically rolled back
    
    # Verifying data has been rolled back
    result = await database.fetch_all(notes.select())
    assert len(result) == 2  # Only data from the first two tasks
    
    await database.disconnect()

# Testing verification
if __name__ == "__main__":
    asyncio.run(test_connection_pool_management())
```

### Node 8: Query Building and Parameter Binding (Query Building and Parameter Binding)

**Description**:
Databases supports SQLAlchemy Core expressions and raw SQL queries, automatically handling parameter binding and query compilation, providing type-safe query interfaces.

**Core Algorithm**:
- Handling query building through `_build_query` method
- Supporting both string SQL and SQLAlchemy expression objects
- Automatic parameter binding and type conversion
- Integrating with SQLAlchemy's query compilation system

**Input/Output Example**:

```python
import asyncio
from databases import Database
import sqlalchemy
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, select, insert, update, delete

async def test_query_building():
    """Testing query building functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    metadata = MetaData()
    users = Table(
        "users",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("name", String(100)),
        Column("email", String(100)),
        Column("active", Boolean, default=True),
    )
    
    # Testing SQLAlchemy Core expressions
    # INSERT query
    insert_query = users.insert()
    await database.execute(insert_query, {"name": "Alice", "email": "alice@example.com"})
    
    # SELECT query
    select_query = select(users.c.name, users.c.email).where(users.c.active == True)
    results = await database.fetch_all(select_query)
    assert len(results) == 1
    assert results[0]["name"] == "Alice"
    
    # UPDATE query
    update_query = update(users).where(users.c.name == "Alice").values(active=False)
    await database.execute(update_query)
    
    # DELETE query
    delete_query = delete(users).where(users.c.active == False)
    await database.execute(delete_query)
    
    # Testing raw SQL query
    raw_sql = "SELECT COUNT(*) as count FROM users"
    result = await database.fetch_one(raw_sql)
    assert result["count"] == 0
    
    # Testing parameterized query
    param_sql = "INSERT INTO users (name, email) VALUES (:name, :email)"
    await database.execute(param_sql, {"name": "Bob", "email": "bob@example.com"})
    
    # Verifying insertion result
    result = await database.fetch_one("SELECT name FROM users WHERE name = :name", {"name": "Bob"})
    assert result["name"] == "Bob"
    
    await database.disconnect()

# Testing verification
if __name__ == "__main__":
    asyncio.run(test_query_building())
```

### Node 9: Batch Operations and Performance Optimization (Batch Operations and Performance Optimization)

**Description**:
Databases supports batch insert, update, and delete operations, optimizing large data processing performance through the `execute_many` method, reducing database round-trip times.

**Core Algorithm**:
- Building batch queries and parameter binding
- Reusing connection pools and batch processing transactions
- Supporting asynchronous iterators for processing large datasets
- Implementing memory optimization and streaming processing

**Input/Output Example**:

```python
import asyncio
from databases import Database
import sqlalchemy
from sqlalchemy import MetaData, Table, Column, Integer, String, DateTime
from datetime import datetime

async def test_batch_operations():
    """Testing batch operations functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table
    metadata = MetaData()
    logs = Table(
        "logs",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("message", String(200)),
        Column("level", String(20)),
        Column("timestamp", DateTime),
    )
    
    # Testing batch insert
    base_time = datetime.now()
    batch_data = [
        {"message": f"Log message {i}", "level": "INFO", "timestamp": base_time}
        for i in range(1000)
    ]
    
    insert_query = logs.insert()
    await database.execute_many(insert_query, batch_data)
    
    # Verifying batch insert result
    count_result = await database.fetch_one("SELECT COUNT(*) as count FROM logs")
    assert count_result["count"] == 1000
    
    # Testing batch update
    update_query = logs.update().where(logs.c.level == "INFO")
    await database.execute_many(update_query, [{"level": "DEBUG"} for _ in range(1000)])
    
    # Verifying batch update result
    debug_count = await database.fetch_one("SELECT COUNT(*) as count FROM logs WHERE level = 'DEBUG'")
    assert debug_count["count"] == 1000
    
    # Testing asynchronous iterator for processing large datasets
    async def process_logs():
        query = logs.select()
        async for record in database.iterate(query):
            # Simulating log processing logic
            assert record["level"] == "DEBUG"
            assert "Log message" in record["message"]
    
    await process_logs()
    
    # Testing batch delete
    delete_query = logs.delete().where(logs.c.level == "DEBUG")
    await database.execute(delete_query)
    
    # Verifying deletion result
    final_count = await database.fetch_one("SELECT COUNT(*) as count FROM logs")
    assert final_count["count"] == 0
    
    await database.disconnect()

# Testing verification
if __name__ == "__main__":
    asyncio.run(test_batch_operations())
```

### Node 10: Error Handling and Exception Management (Error Handling and Exception Management)

**Description**:
Databases provides comprehensive error handling mechanisms, including connection errors, transaction rollbacks, query execution exceptions, etc., ensuring application robustness and data consistency.

**Core Algorithm**:
- Exception handling and classification
- Automatic transaction rollback and connection cleanup
- Logging errors and debugging information
- Graceful degradation and retry mechanisms

**Input/Output Example**:

```python
import asyncio
from databases import Database
import sqlalchemy
from sqlalchemy import MetaData, Table, Column, Integer, String, CheckConstraint
from sqlalchemy.exc import IntegrityError

async def test_error_handling():
    """Testing error handling functionality"""
    database = Database("sqlite:///test.db")
    await database.connect()
    
    # Creating test table with constraints
    metadata = MetaData()
    products = Table(
        "products",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("name", String(100), nullable=False),
        Column("price", Integer, nullable=False),
        CheckConstraint("price > 0", name="positive_price"),
    )
    
    # Testing constraint violation error
    try:
        await database.execute(products.insert(), {"name": "Test Product", "price": -10})
        assert False, "A constraint violation exception should be raised"
    except IntegrityError as e:
        assert "positive_price" in str(e)
    
    # Testing transaction rollback
    try:
        async with database.transaction():
            await database.execute(products.insert(), {"name": "Valid Product", "price": 100})
            # Intentional violation of constraint
            await database.execute(products.insert(), {"name": "Invalid Product", "price": -50})
    except IntegrityError:
        # Transaction should automatically roll back
        pass
    
    # Verifying data has been rolled back
    result = await database.fetch_all(products.select())
    assert len(result) == 0
    
    # Testing error handling for invalid database connection
    try:
        invalid_db = Database("postgresql://invalid:5432/nonexistent")
        await invalid_db.connect()
        assert False, "A connection error should be raised"
    except Exception as e:
        assert "connection" in str(e).lower() or "connect" in str(e).lower()
    
    # Testing syntax error in query
    try:
        await database.execute("SELECT * FROM nonexistent_table")
        assert False, "A table not found error should be raised"
    except Exception as e:
        assert "table" in str(e).lower() or "no such" in str(e).lower()
    
    # Testing graceful error recovery
    async with database.transaction():
        await database.execute(products.insert(), {"name": "Recovery Test", "price": 200})
        # Even if an error occurs here, the transaction will be correctly handled
    
    # Verifying data after recovery
    result = await database.fetch_one(products.select())
    assert result["name"] == "Recovery Test"
    assert result["price"] == 200
    
    await database.disconnect()

# Testing verification
if __name__ == "__main__":
    asyncio.run(test_error_handling())
```


