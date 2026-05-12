# Introduction and Goals of the FastAPI Users Project

**FastAPI Users** is a user management system library specifically designed for the FastAPI framework, offering ready-to-use and customizable user authentication and authorization solutions. The project aims to simplify the development of user management functions in FastAPI applications, enabling developers to quickly integrate a complete user system without building from scratch.

# Natural Language Instruction (Prompt)

Please create a Python project named FastAPI-Users-Auth to implement a complete user authentication and authorization management system. The project should include the following features:

1. User Manager Module: Implement core operations such as user creation, update, deletion, and query, supporting asynchronous database operations. It should include user model definitions (supporting fields such as email, password, activation status, verification status, and superuser permissions), user creation and update schemas, and complete user lifecycle management. The manager should support custom user model extensions and provide a unified user operation interface.

2. Authentication System Module: Implement a combination of multiple authentication strategies and transmission methods, including JWT strategy, database token strategy, Redis strategy, etc. Support Bearer token and Cookie transmission methods and provide configurable authentication backends. The authentication system should support token generation, verification, refresh, and revocation functions to ensure secure user session management.

3. Database Adapter Module: Provide a unified database operation interface, supporting different database backends such as SQLAlchemy (relational database) and Beanie (MongoDB). The adapter should implement standard CRUD operations, support asynchronous operations, and provide database connection management and transaction processing functions.

4. OAuth Integration Module: Support login and account association functions for third-party OAuth providers (such as Google, GitHub, Facebook, etc.). Implement the OAuth authorization process, callback handling, account association, and user information synchronization. Support the simultaneous integration of multiple OAuth providers and provide a unified OAuth management interface.

5. Password Security Module: Implement a secure password hashing and verification mechanism, supporting multiple hashing algorithms (such as Argon2, bcrypt, etc.). Provide functions such as password strength verification, password reset, and email verification. Ensure the security of password storage and transmission and support password policy configuration.

6. API Routing Module: Provide a complete set of RESTful API interfaces, including routes for user registration, login, logout, password reset, email verification, and user information management. Each route should support appropriate HTTP methods, request verification, response formatting, and error handling. Routes should support dependency injection and middleware integration.

7. Configuration and Dependency Management: The project must include a complete `pyproject.toml` file, declaring a complete list of dependencies (including core libraries such as fastapi, pwdlib, email-validator, pyjwt, python-multipart, makefun, etc.), and support project installation and distribution. Provide unified configuration management, supporting environment variables and configuration files.

8. Testing and Documentation: Provide a complete test suite, including unit tests, integration tests, and end-to-end tests. Tests should cover all core functional modules, including user management, authentication, OAuth, password security, etc. Provide detailed API documentation and usage examples to ensure the project's maintainability and extensibility.

9. Core File Requirements: The project must include a complete pyproject.toml file, which should configure the project as an installable package (supporting `pip install`) and declare a complete list of dependencies (such as `fastapi >= 0.65.2`, `pwdlib[argon2,bcrypt] == 0.2.1`, `email-validator >= 1.1.0, < 2.3`, `pyjwt[crypto] == 2.10.1`, `python-multipart == 0.0.20`, `makefun >= 1.11.2, < 2.0.0`, etc., the actual core libraries used). The pyproject.toml should ensure that all core functional modules can work properly. At the same time, it is necessary to provide `fastapi_users/__init__.py` as a unified API entry, importing and exporting `Depends`, `FastAPI`, `Request`, `Response`, `status`, `OAuth2PasswordRequestForm`, `SecurityBase`, `BaseUserDatabase`, and the main import and export functions, and provide version information, allowing users to access all main functions through simple statements such as `from fastapi import *` and `from fastapi_users.responses/security/authentication/exceptions/jwt/manager/router import *`.

# Environment Configuration

## Python Version

The Python version used in the current project is: Python 3.10.11

## Core Dependency Library Versions

Core dependencies
```
annotated-types          0.7.0
anyio                    4.10.0
argon2-cffi              23.1.0
argon2-cffi-bindings     25.1.0
asgi-lifespan            2.1.0
async-timeout            5.0.1
backports.asyncio.runner 1.2.0
bcrypt                   4.3.0
certifi                  2025.8.3
cffi                     1.17.1
click                    8.2.1
coverage                 7.10.2
cryptography             45.0.5
dnspython                2.7.0
email_validator          2.2.0
exceptiongroup           1.3.0
h11                      0.16.0
httpcore                 1.0.9
httpx                    0.28.1
httpx-oauth              0.16.1
idna                     3.10
iniconfig                2.1.0
isort                    6.0.1
makefun                  1.16.0
mypy                     1.17.1
mypy_extensions          1.1.0
packaging                25.0
pathspec                 0.12.1
pip                      23.0.1
pluggy                   1.6.0
pwdlib                   0.2.1
pycparser                2.22
pydantic                 2.11.7
pydantic_core            2.33.2
Pygments                 2.19.2
PyJWT                    2.10.1
pytest                   8.4.1
pytest-asyncio           1.1.0
pytest-cov               6.2.1
pytest-mock              3.14.1
python-multipart         0.0.20
redis                    5.3.1
ruff                     0.12.7
setuptools               65.5.1
sniffio                  1.3.1
starlette                0.47.2
tomli                    2.2.1
typing_extensions        4.14.1
typing-inspection        0.4.1
uvicorn                  0.35.0
wheel                    0.40.0
fastapi                  0.65.2
motor                    3.7.1
beanie                   2.0.0
jwt                      2.10.1
fastapi_users_db_beanie  4.0.0
fastapi_users_db_sqlalchemy  7.0.0
```

## fastapi-users Project Architecture

### Project Directory Structure

```
workspace/
├── .all-contributorsrc
├── .editorconfig
├── .gitignore
├── LICENSE
├── README.md
├── fastapi_users
│   ├── __init__.py
│   ├── authentication
│   │   ├── __init__.py
│   │   ├── authenticator.py
│   │   ├── backend.py
│   │   ├── strategy
│   │   │   ├── __init__.py
│   │   │   ├── base.py
│   │   │   ├── db
│   │   │   │   ├── __init__.py
│   │   │   │   ├── adapter.py
│   │   │   │   ├── models.py
│   │   │   │   ├── strategy.py
│   │   │   ├── jwt.py
│   │   │   ├── redis.py
│   │   ├── transport
│   │   │   ├── __init__.py
│   │   │   ├── base.py
│   │   │   ├── bearer.py
│   │   │   └── cookie.py
│   ├── db
│   │   ├── __init__.py
│   │   ├── base.py
│   ├── exceptions.py
│   ├── fastapi_users.py
│   ├── jwt.py
│   ├── manager.py
│   ├── models.py
│   ├── openapi.py
│   ├── password.py
│   ├── py.typed
│   ├── router
│   │   ├── __init__.py
│   │   ├── auth.py
│   │   ├── common.py
│   │   ├── oauth.py
│   │   ├── register.py
│   │   ├── reset.py
│   │   ├── users.py
│   │   ├── verify.py
│   ├── schemas.py
│   ├── types.py
├── logo.svg
├── logo_github.png
├── mkdocs.yml
└── pyproject.toml

```

## API Usage Guide

### Core APIs

#### 1. Module Import

```python
from fastapi import Depends, FastAPI, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordRequestForm, SecurityBase

from fastapi_users import FastAPIUsers, models, schemas
from fastapi_users.authentication import (
    AuthenticationBackend,Authenticator,
)
from fastapi_users.authentication.authenticator import DuplicateBackendNamesError
from fastapi_users.authentication.strategy import (
    AccessTokenDatabase,AccessTokenProtocol,DatabaseStrategy,JWTStrategy,JWTStrategyDestroyNotSupportedError,RedisStrategy,Strategy,StrategyDestroyNotSupportedError,
)
from fastapi_users.authentication.transport import (
    BearerTransport,CookieTransport,Transport,TransportLogoutNotSupportedError,
)
from fastapi_users.authentication.transport.bearer import BearerResponse
from fastapi_users.db import BaseUserDatabase
from fastapi_users.exceptions import (
    FastAPIUsersException,InvalidID,InvalidPasswordException,InvalidResetPasswordToken,InvalidVerifyToken,UserAlreadyExists,UserAlreadyVerified,UserInactive,UserNotExists,
)
from fastapi_users.jwt import SecretType, decode_jwt, generate_jwt, _get_secret_value
from fastapi_users.authentication.authenticator import name_to_variable_name, name_to_strategy_variable_name
from fastapi_users.manager import BaseUserManager, IntegerIDMixin, UUIDIDMixin
from fastapi_users.models import UserProtocol, OAuthAccountProtocol, UserOAuthProtocol
from fastapi_users.password import PasswordHelperProtocol
from fastapi_users.schemas import CreateUpdateDictModel, BaseOAuthAccount, BaseOAuthAccountMixin
from fastapi_users.router import (
    ErrorCode,get_auth_router,get_register_router,get_reset_password_router,get_users_router,get_verify_router,
)
from fastapi_users.router.common import ErrorCode, ErrorModel, ErrorCodeReasonModel
from fastapi_users.router.oauth import (
    generate_state_token,get_oauth_associate_router,get_oauth_router,OAuth2AuthorizeResponse,
)
```

#### 2. FastAPIUsers Class - Core Application Manager

**Class Description**: 
Main object that ties together the component for users authentication.

:param get_user_manager: Dependency callable getter to inject the
user manager class instance.
:param auth_backends: List of authentication backends.

:attribute current_user: Dependency callable getter to inject authenticated user
with a specific set of parameters.

**API Summary**:

```python
class FastAPIUsers(Generic[models.UP, models.ID]):
    """
    Main object that ties together the component for users authentication.

    :param get_user_manager: Dependency callable getter to inject the
    user manager class instance.
    :param auth_backends: List of authentication backends.

    :attribute current_user: Dependency callable getter to inject authenticated user
    with a specific set of parameters.
    """

    def __init__(
        self,
        get_user_manager: UserManagerDependency[models.UP, models.ID],
        auth_backends: Sequence[AuthenticationBackend[models.UP, models.ID]],
    ): ...
    def get_register_router(self, user_schema: type[schemas.U], user_create_schema: type[schemas.UC]) -> APIRouter: ...
    def get_verify_router(self, user_schema: type[schemas.U]) -> APIRouter: ...
    def get_reset_password_router(self) -> APIRouter: ...
    def get_auth_router(
        self,
        backend: AuthenticationBackend[models.UP, models.ID],
        requires_verification: bool = False,
    ) -> APIRouter: ...
    def get_oauth_router(
        self,
        oauth_client: BaseOAuth2,
        backend: AuthenticationBackend[models.UP, models.ID],
        state_secret: SecretType,
        redirect_url: Optional[str] = None,
        associate_by_email: bool = False,
        is_verified_by_default: bool = False,
    ) -> APIRouter: ...
    def get_oauth_associate_router(
        self,
        oauth_client: BaseOAuth2,
        user_schema: type[schemas.U],
        state_secret: SecretType,
        redirect_url: Optional[str] = None,
        requires_verification: bool = False,
    ) -> APIRouter: ...
    def get_users_router(
        self,
        user_schema: type[schemas.U],
        user_update_schema: type[schemas.UU],
        requires_verification: bool = False,
    ) -> APIRouter: ...
```

**Main Method Descriptions**:

- __init__(get_user_manager, auth_backends): Initialize FastAPIUsers instance with user manager dependency and authentication backend list.
- get_register_router(user_schema, user_create_schema): Return router with registration routes. user_schema is the data model for public user, user_create_schema is the data model for creating users.
- get_verify_router(user_schema): Return router with email verification routes. user_schema is the data model for public user.
- get_reset_password_router(): Return router for password reset flow.
- get_auth_router(backend, requires_verification): Return authentication router for a given authentication backend. backend is an authentication backend instance, requires_verification specifies whether authentication requires user verification, default is False.
- get_oauth_router(oauth_client, backend, state_secret, redirect_url, associate_by_email, is_verified_by_default): Return OAuth router for a given OAuth client and authentication backend. oauth_client is an HTTPX OAuth client instance, backend is an authentication backend instance, state_secret is the key for encoding state JWT, redirect_url is an optional OAuth2 flow redirect URL, associate_by_email specifies whether to associate users by email, default is False, is_verified_by_default specifies whether newly created users are set as verified by default, default is False.
- get_oauth_associate_router(oauth_client, user_schema, state_secret, redirect_url, requires_verification): Return OAuth association router for a given OAuth client. oauth_client is an HTTPX OAuth client instance, user_schema is the data model for public user, state_secret is the key for encoding state JWT, redirect_url is an optional OAuth2 flow redirect URL, requires_verification specifies whether endpoints require user verification, default is False.
- get_users_router(user_schema, user_update_schema, requires_verification): Return router for managing user routes. user_schema is the data model for public user, user_update_schema is the data model for updating users, requires_verification specifies whether endpoints require user verification, default is False.

#### 4. get_auth_router() Function - Authentication Route Generator

**Function description**: Generates a router with login/logout routes for an authentication backend. This function creates API routes for authentication including login and logout endpoints with proper error handling and token management.

**Function Signature**:
```python
from fastapi_users.router.auth import get_auth_router

def get_auth_router(
    backend: AuthenticationBackend[models.UP, models.ID],
    get_user_manager: UserManagerDependency[models.UP, models.ID],
    authenticator: Authenticator[models.UP, models.ID],
    requires_verification: bool = False,
) -> APIRouter:
```

**Parameters**:
- `backend` (AuthenticationBackend[models.UP, models.ID]): The authentication backend to use
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager
- `authenticator` (Authenticator[models.UP, models.ID]): The authenticator instance
- `requires_verification` (bool): Whether email verification is required, default is False

**Returns**:
- `APIRouter`: A FastAPI router instance containing the authentication routes

#### 5. get_register_router() Function - Registration Route Generator

**Function description**: Generates a router with the register route for user registration. This function creates an endpoint for new user registration with proper validation and error handling.

**Function Signature**:
```python
from fastapi_users.router.register import get_register_router

def get_register_router(
    get_user_manager: UserManagerDependency[models.UP, models.ID],
    user_schema: type[schemas.U],
    user_create_schema: type[schemas.UC],
) -> APIRouter:
```

**Parameters**:
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager
- `user_schema` (type[schemas.U]): The user schema for response serialization
- `user_create_schema` (type[schemas.UC]): The user creation schema for request validation

**Returns**:
- `APIRouter`: A FastAPI router instance containing the registration route

#### 6. get_users_router() Function - User Management Route Generator

**Function description**: Generates a router with the user management routes for retrieving, updating, and deleting users. This function creates endpoints for user operations with proper authentication and authorization checks.

**Function Signature**:
```python
from fastapi_users.router.users import get_users_router

def get_users_router(
    get_user_manager: UserManagerDependency[models.UP, models.ID],
    user_schema: type[schemas.U],
    user_update_schema: type[schemas.UU],
    authenticator: Authenticator[models.UP, models.ID],
    requires_verification: bool = False,
) -> APIRouter:
```

**Parameters**:
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager
- `user_schema` (type[schemas.U]): The user schema for response serialization
- `user_update_schema` (type[schemas.UU]): The user update schema for request validation
- `authenticator` (Authenticator[models.UP, models.ID]): The authenticator instance
- `requires_verification` (bool): Whether email verification is required, default is False

**Returns**:
- `APIRouter`: A FastAPI router instance containing the user management routes

#### 7. get_verify_router() Function - Email Verification Route Generator

**Function description**: Generates a router with the email verification routes for user verification functionality. This function creates endpoints for requesting verification tokens and verifying user emails with proper validation and error handling.

**Function Signature**:
```python
from fastapi_users.router.verify import get_verify_router

def get_verify_router(
    get_user_manager: UserManagerDependency[models.UP, models.ID],
    user_schema: type[schemas.U],
):
```

**Parameters**:
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager
- `user_schema` (type[schemas.U]): The user schema for response serialization

**Returns**:
- `APIRouter`: A FastAPI router instance containing the email verification routes

#### 8. get_reset_password_router() Function - Password Reset Route Generator

**Function description**: Generates a router with the reset password routes for password recovery functionality. This function creates endpoints for initiating password reset and confirming new passwords with proper token validation.

**Function Signature**:
```python
def get_reset_password_router(
    get_user_manager: UserManagerDependency[models.UP, models.ID],
) -> APIRouter:
```

**Parameters**:
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager

**Returns**:
- `APIRouter`: A FastAPI router instance containing the password reset routes

#### 9. get_oauth_router() Function - OAuth Route Generator

**Function description**: Generates a router with the OAuth routes for handling OAuth authentication flows. This function creates endpoints for OAuth authorization and callback handling, including proper token management and user creation/association.

**Function Signature**:

```python
from fastapi_users.router.oauth import get_oauth_router
def get_oauth_router(
    oauth_client: BaseOAuth2,
    backend: AuthenticationBackend[models.UP, models.ID],
    get_user_manager: UserManagerDependency[models.UP, models.ID],
    state_secret: SecretType,
    redirect_url: Optional[str] = None,
    associate_by_email: bool = False,
    is_verified_by_default: bool = False,
) -> APIRouter:
```

**Parameters**:

- `oauth_client` (BaseOAuth2): The OAuth client instance for the specific provider
- `backend` (AuthenticationBackend[models.UP, models.ID]): The authentication backend to use
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager
- `state_secret` (SecretType): The secret key for encoding state tokens
- `redirect_url` (Optional[str]): The redirect URL for the OAuth flow, defaults to callback endpoint
- `associate_by_email` (bool): Whether to associate accounts by email if user exists, default is False
- `is_verified_by_default` (bool): Whether new users created via OAuth are marked as verified, default is False

**Returns**:

- `APIRouter`: A FastAPI router instance containing the OAuth routes

#### 10. UUIDIDMixin Class - UUID ID Parsing Mixin Class

**Class Description**: Mixin class for UUID ID processing.

**API Summary**:

```python
class UUIDIDMixin:
    def parse_id(self, value: Any) -> uuid.UUID: ...
```

**Main Method Descriptions**:

- parse_id(value): Parses the value as a UUID. If the value is a UUID instance, it returns it directly, otherwise it attempts to convert it to a UUID. Raises InvalidID exception if conversion fails.

#### 11. Type Variables and Constants
```python
import re
from typing import TypeVar
from pydantic import BaseModel, VERSION as PYDANTIC_VERSION
from fastapi_users.models import UserProtocol, OAuthAccountProtocol, UserOAuthProtocol

# Type Variables
ID = TypeVar("ID")  # Generic type variable for user ID
UP = TypeVar("UP", bound=UserProtocol)  # User protocol type variable
OAP = TypeVar("OAP", bound=OAuthAccountProtocol)  # OAuth account protocol type variable
UOAP = TypeVar("UOAP", bound=UserOAuthProtocol)  # User OAuth protocol type variable
SCHEMA = TypeVar("SCHEMA", bound=BaseModel)  # Schema type variable

# JWT Constants
JWT_ALGORITHM = "HS256"  # Default JWT signing algorithm

# Token Audience Constants
RESET_PASSWORD_TOKEN_AUDIENCE = "fastapi-users:reset"  # Reset password token audience
VERIFY_USER_TOKEN_AUDIENCE = "fastapi-users:verify"  # Verify user token audience
STATE_TOKEN_AUDIENCE = "fastapi-users:oauth-state"  # OAuth state token audience

# Pydantic Version Detection
PYDANTIC_V2 = PYDANTIC_VERSION.startswith("2.")  # Detect Pydantic version

# Validation Pattern Constants
INVALID_CHARS_PATTERN = re.compile(r"[^0-9a-zA-Z_]")  # Invalid characters pattern
INVALID_LEADING_CHARS_PATTERN = re.compile(r"^[^a-zA-Z_]+")  # Invalid leading characters pattern

# Return Type Constants
RETURN_TYPE = TypeVar("RETURN_TYPE")  # Generic return type variable

# Database Configuration Constants
DATABASE_URL = "mongodb://localhost:27017"  # MongoDB database connection URL (Beanie example)
DATABASE_URL = "sqlite+aiosqlite:///./test.db"  # SQLite database connection URL (SQLAlchemy example)

# Reset Password Response Constants
RESET_PASSWORD_RESPONSES: OpenAPIResponseType = {
    status.HTTP_400_BAD_REQUEST: {
        "model": ErrorModel,
        "content": {
            "application/json": {
                "examples": {
                    ErrorCode.RESET_PASSWORD_BAD_TOKEN: {
                        "summary": "Bad or expired token.",
                        "value": {"detail": ErrorCode.RESET_PASSWORD_BAD_TOKEN},
                    },
                    ErrorCode.RESET_PASSWORD_INVALID_PASSWORD: {
                        "summary": "Password validation failed.",
                        "value": {
                            "detail": {
                                "code": ErrorCode.RESET_PASSWORD_INVALID_PASSWORD,
                                "reason": "Password should be at least 3 characters",
                            }
                        },
                    },
                }
            }
        },
    },
}  # OpenAPI response definitions for reset password endpoint, including bad token and invalid password error cases

```

#### 12. UserProtocol - User Protocol Interface

**Class Description**: User protocol that ORM model should follow.

**API Summary**:

```python
class UserProtocol(Protocol[models.ID]):
    """User protocol that ORM model should follow."""
```
**Attributes**:

- `id` (models.ID): The unique identifier for the user
- `email` (str): The email address of the user
- `hashed_password` (str): The hashed password of the user
- `is_active` (bool): Whether the user account is active
- `is_superuser` (bool): Whether the user has superuser privileges
- `is_verified` (bool): Whether the user account is verified

#### 13. OAuthAccountProtocol - OAuth Account Protocol Interface

**Class Description**: OAuth account protocol that ORM model should follow.

**API Summary**:

```python
class OAuthAccountProtocol(Protocol[models.ID]):
    """OAuth account protocol that ORM model should follow."""

    id: models.ID
    oauth_name: str
    access_token: str
    expires_at: Optional[int]
    refresh_token: Optional[str]
    account_id: str
    account_email: str
```

#### 14. UserOAuthProtocol - User OAuth Protocol Interface

**Class Description**: User protocol including a list of OAuth accounts.

**API Summary**:

```python
class UserOAuthProtocol(UserProtocol[models.ID], Generic[models.ID, OAP]):
    """User protocol including a list of OAuth accounts."""

    id: models.ID
    email: str
    hashed_password: str
    is_active: bool
    is_superuser: bool
    is_verified: bool
    oauth_accounts: list[OAP]
```

#### 15. PasswordHelperProtocol - Password Helper Protocol Interface

**Class Description**: Password helper protocol.

**API Summary**:

```python
class PasswordHelperProtocol(Protocol):
    def verify_and_update(
        self, plain_password: str, hashed_password: str
    ) -> tuple[bool, Union[str, None]]: ...
    def hash(self, password: str) -> str: ...
    def generate(self) -> str: ...
```

**Main Method Descriptions**:

- verify_and_update(plain_password, hashed_password): Verifies whether the plain password matches the hashed password. Returns a tuple containing whether the match was successful and the updated hashed password (if update is needed).
- hash(password): Hashes a password.
- generate(): Generates a random password.

#### 16. CreateUpdateDictModel - Create Update Dictionary Model Base Class

**Class Description**: Base model that provides helper methods for creating and updating dictionaries.

**API Summary**:

```python
class CreateUpdateDictModel(BaseModel):
    def create_update_dict(self): ...
    def create_update_dict_superuser(self): ...
```

**Main Method Descriptions**:

- create_update_dict(): Creates a dictionary excluding unset fields and sensitive fields (id, is_superuser, is_active, is_verified, oauth_accounts).
- create_update_dict_superuser(): Creates a dictionary excluding unset fields but not excluding sensitive fields (applicable for superuser operations).

#### 17. BaseOAuthAccount - OAuth Account Base Model

**Class Description**: Base OAuth account model.

**API Summary**:

```python
class BaseOAuthAccount(BaseModel, Generic[models.ID]):
    """Base OAuth account model."""

    id: models.ID
    oauth_name: str
    access_token: str
    expires_at: Optional[int] = None
    refresh_token: Optional[str] = None
    account_id: str
    account_email: str
```

#### 18. BaseOAuthAccountMixin - OAuth Account Mixin Class

**Class Description**: Adds OAuth accounts list to a User model.

**API Summary**:

```python
class BaseOAuthAccountMixin(BaseModel):
    """Adds OAuth accounts list to a User model."""

    oauth_accounts: list[BaseOAuthAccount] = []
```

#### API Components Reference

#### Classes

##### FastAPIUsersException Class

**Class Description**: Base exception class for FastAPI-Users exceptions.

**API Summary**:

```python
class FastAPIUsersException(Exception):
    pass
```

##### InvalidID Class

**Class Description**: Exception raised when ID parsing fails.

**API Summary**:

```python
class InvalidID(FastAPIUsersException):
    pass
```

##### UserAlreadyExists Class

**Class Description**: Exception raised when attempting to create a user that already exists.

**API Summary**:

```python
class UserAlreadyExists(FastAPIUsersException):
    pass
```

##### UserNotExists Class

**Class Description**: Exception raised when attempting to access a user that does not exist.

**API Summary**:

```python
class UserNotExists(FastAPIUsersException):
    pass
```

##### UserInactive Class

**Class Description**: Exception raised when attempting to perform operations with an inactive user.

**API Summary**:

```python
class UserInactive(FastAPIUsersException):
    pass
```

##### UserAlreadyVerified Class

**Class Description**: Exception raised when attempting to verify an already verified user.

**API Summary**:

```python
class UserAlreadyVerified(FastAPIUsersException):
    pass
```

##### InvalidVerifyToken Class

**Class Description**: Exception raised when the verification token is invalid or expired.

**API Summary**:

```python
class InvalidVerifyToken(FastAPIUsersException):
    pass
```

##### InvalidResetPasswordToken Class

**Class Description**: Exception raised when the password reset token is invalid or expired.

**API Summary**:

```python
class InvalidResetPasswordToken(FastAPIUsersException):
    pass
```

##### InvalidPasswordException Class

**Class Description**: Exception raised when the password is invalid.

**API Summary**:

```python
class InvalidPasswordException(FastAPIUsersException):
    def __init__(self, reason: Any) -> None: ...
```

**Main Method Descriptions**:

- **init**(reason): Initializes the exception with the given reason.

##### BaseUserManager Class

**Class Description**:
User management logic.

:attribute reset_password_token_secret: Secret to encode reset password token.
:attribute reset_password_token_lifetime_seconds: Lifetime of reset password token.
:attribute reset_password_token_audience: JWT audience of reset password token.
:attribute verification_token_secret: Secret to encode verification token.
:attribute verification_token_lifetime_seconds: Lifetime of verification token.
:attribute verification_token_audience: JWT audience of verification token.

:param user_db: Database adapter instance.

**API Summary**:

```python
class BaseUserManager(Generic[models.UP, models.ID]):

    def __init__(
        self,
        user_db: BaseUserDatabase[models.UP, models.ID],
        password_helper: Optional[PasswordHelperProtocol] = None,
    ) -> None: ...
    def parse_id(self, value: Any) -> models.ID: ...
    async def get(self, id: models.ID) -> models.UP: ...
    async def get_by_email(self, user_email: str) -> models.UP: ...
    async def get_by_oauth_account(self, oauth: str, account_id: str) -> models.UP: ...
    async def create(
        self,
        user_create: schemas.UC,
        safe: bool = False,
        request: Optional[Request] = None,
    ) -> models.UP: ...
    async def oauth_callback(
        self: "BaseUserManager[models.UOAP, models.ID]",
        oauth_name: str,
        access_token: str,
        account_id: str,
        account_email: str,
        expires_at: Optional[int] = None,
        refresh_token: Optional[str] = None,
        request: Optional[Request] = None,
        *,
        associate_by_email: bool = False,
        is_verified_by_default: bool = False,
    ) -> models.UOAP: ...
    async def oauth_associate_callback(
        self: "BaseUserManager[models.UOAP, models.ID]",
        user: models.UOAP,
        oauth_name: str,
        access_token: str,
        account_id: str,
        account_email: str,
        expires_at: Optional[int] = None,
        refresh_token: Optional[str] = None,
        request: Optional[Request] = None,
    ) -> models.UOAP: ...
    async def request_verify(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def verify(self, token: str, request: Optional[Request] = None) -> models.UP: ...
    async def forgot_password(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def reset_password(
        self, token: str, password: str, request: Optional[Request] = None
    ) -> models.UP: ...
    async def update(
        self,
        user_update: schemas.UU,
        user: models.UP,
        safe: bool = False,
        request: Optional[Request] = None,
    ) -> models.UP: ...
    async def delete(
        self,
        user: models.UP,
        request: Optional[Request] = None,
    ) -> None: ...
    async def validate_password(
        self, password: str, user: Union[schemas.UC, models.UP]
    ) -> None: ...
    async def on_after_register(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def on_after_update(
        self,
        user: models.UP,
        update_dict: dict[str, Any],
        request: Optional[Request] = None,
    ) -> None: ...
    async def on_after_request_verify(
        self, user: models.UP, token: str, request: Optional[Request] = None
    ) -> None: ...
    async def on_after_verify(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def on_after_forgot_password(
        self, user: models.UP, token: str, request: Optional[Request] = None
    ) -> None: ...
    async def on_after_reset_password(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def on_after_login(
        self,
        user: models.UP,
        request: Optional[Request] = None,
        response: Optional[Response] = None,
    ) -> None: ...
    async def on_before_delete(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def on_after_delete(
        self, user: models.UP, request: Optional[Request] = None
    ) -> None: ...
    async def authenticate(
        self, credentials: OAuth2PasswordRequestForm
    ) -> Optional[models.UP]: ...
    async def _update(self, user: models.UP, update_dict: dict[str, Any]) -> models.UP: ...
```

**Main Method Descriptions**:

- **init**(user_db, password_helper): Initializes a BaseUserManager instance with the database adapter and optional password helper.
- parse_id(value): Parses the value as the correct models.ID instance. The parameter value is the value to be parsed. Raises an InvalidID exception if the ID value is invalid. Returns a models.ID object.
- get(id): Gets a user by ID. The parameter id is the ID of the user to retrieve. Raises a UserNotExists exception if the user does not exist. Returns a user.
- get_by_email(user_email): Gets a user by email. The parameter user_email is the email of the user to retrieve. Raises a UserNotExists exception if the user does not exist. Returns a user.
- get_by_oauth_account(oauth, account_id): Gets a user by OAuth account. The parameter oauth is the name of the OAuth client, and account_id is the account ID on the external OAuth service. Raises a UserNotExists exception if the user does not exist. Returns a user.
- create(user_create, safe, request): Creates a user in the database. Triggers the on_after_register handler upon success. The parameter user_create is the UserCreate model to be created, safe specifies whether to ignore sensitive values like is_superuser or is_verified during creation (default is False), and request is an optional FastAPI request that triggers the operation (default is None). Raises a UserAlreadyExists exception if a user with the same email already exists. Returns a new user.
- oauth_callback(oauth_name, access_token, account_id, account_email, expires_at, refresh_token, request, associate_by_email, is_verified_by_default): Handles the callback after successful OAuth authentication. Parameters include the OAuth client name, valid access token, user ID, user email, etc. If associate_by_email is True, the OAuth account will be associated with an existing user with the same email. If the user does not exist, creates the user and triggers the on_after_register handler. Returns a user.
- oauth_associate_callback(oauth_name, user, access_token, account_id, account_email, expires_at, refresh_token, request): Handles the callback after successful OAuth association. Adds the new OAuth account to the given user. Returns a user.
- request_verify(user, request): Initiates a verification request. Triggers the on_after_request_verify handler upon success. The parameter user is the user to be verified, and request is an optional FastAPI request that triggers the operation (default is None). Raises a UserInactive exception if the user is inactive, and raises a UserAlreadyVerified exception if the user is already verified.
- verify(token, request): Verifies the request. Sets the user's is_verified flag to True. Triggers the on_after_verify handler upon success. The parameter token is the verification token generated by request_verify, and request is an optional FastAPI request that triggers the operation (default is None). Raises an InvalidVerifyToken exception if the token is invalid or expired, and raises a UserAlreadyVerified exception if the user is already verified. Returns the verified user.
- forgot_password(user, request): Initiates a forgot password request. Triggers the on_after_forgot_password handler upon success. The parameter user is the user requesting to reset the password, and request is an optional FastAPI request that triggers the operation (default is None). Raises a UserInactive exception if the user is inactive.
- reset_password(token, password, request): Resets the user's password. Triggers the on_after_reset_password handler upon success. The parameter token is the token generated by forgot_password, password is the new password to be set, and request is an optional FastAPI request that triggers the operation (default is None). Raises an InvalidResetPasswordToken exception if the token is invalid or expired, raises a UserInactive exception if the user is inactive, and raises an InvalidPasswordException if the password is invalid. Returns the user with the updated password.
- update(user_update, user, safe, request): Updates a user. Triggers the on_after_update handler upon success. The parameter user_update contains the UserUpdate model with changes to be applied to the user, user is the current user to be updated, safe specifies whether to ignore sensitive values like is_superuser or is_verified during the update (default is False), and request is an optional FastAPI request that triggers the operation (default is None). Returns the updated user.
- delete(user, request): Deletes a user. The parameter user is the user to be deleted, and request is an optional FastAPI request that triggers the operation (default is None).
- validate_password(password, user): Validates a password. You should override this method to add your own validation logic. The parameter password is the password to be validated, and user is the user associated with this password. Raises an InvalidPasswordException if the password is invalid. Returns None if the password is valid.
- on_after_register(user, request): Executes logic after successful user registration. You should override this method to add your own logic. The parameter user is the registered user, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_update(user, update_dict, request): Executes logic after successful user update. You should override this method to add your own logic. The parameter user is the updated user, update_dict is a dictionary containing the updated user fields, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_request_verify(user, token, request): Executes logic after successful verification request. You should override this method to add your own logic. The parameter user is the user to be verified, token is the verification token, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_verify(user, request): Executes logic after successful user verification. You should override this method to add your own logic. The parameter user is the verified user, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_forgot_password(user, token, request): Executes logic after successful forgot password request. You should override this method to add your own logic. The parameter user is the user requesting password reset, token is the forgot password token, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_reset_password(user, request): Executes logic after successful password reset. You should override this method to add your own logic. The parameter user is the user resetting the password, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_login(user, request, response): Executes logic after user login. You should override this method to add your own logic. The parameter user is the logged-in user, request is an optional FastAPI request, and response is an optional response built by the transport.
- on_before_delete(user, request): Executes logic before deleting a user. You should override this method to add your own logic. The parameter user is the user to be deleted, and request is an optional FastAPI request that triggers the operation (default is None).
- on_after_delete(user, request): Executes logic after deleting a user. You should override this method to add your own logic. The parameter user is the user that was deleted, and request is an optional FastAPI request that triggers the operation (default is None).
- authenticate(credentials): Authenticates and returns a user based on email and password. Automatically upgrades password hash if necessary. The parameter credentials are the user credentials.
- _update(user, update_dict): Internal method to update a user. The parameter user is the user to be updated, and update_dict is the dictionary of updates to be applied.

##### IntegerIDMixin Class

**Class Description**: Mixin class for integer ID handling.

**API Summary**:

```python
class IntegerIDMixin:
    def parse_id(self, value: Any) -> int: ...
```

**Main Method Descriptions**:

- parse_id(value): Parses the value as an integer. Raises an InvalidID exception if the value is a float. Otherwise, attempts to convert it to an integer, and raises an InvalidID exception if the conversion fails.

##### PasswordHelper Class

**Class Description**: Password helper implementation.

**API Summary**:

```python
class PasswordHelper(PasswordHelperProtocol):
    def __init__(self, password_hash: Optional[PasswordHash] = None) -> None: ...
    def verify_and_update(
        self, plain_password: str, hashed_password: str
    ) -> tuple[bool, Union[str, None]]: ...
    def hash(self, password: str) -> str: ...
    def generate(self) -> str: ...
```

**Main Method Descriptions**:

- **init**(password_hash): Initializes a PasswordHelper instance with the specified PasswordHash. Uses default Argon2 and Bcrypt hashers if not provided.
- verify_and_update(plain_password, hashed_password): Verifies whether the plain password matches the hashed password. Returns a tuple containing whether the match was successful and the updated hashed password (if update is needed).
- hash(password): Hashes a password.
- generate(): Generates a random password.

##### BaseUser Class

**Class Description**: Base User model.

**API Summary**:

```python
class BaseUser(CreateUpdateDictModel, Generic[models.ID]):
    """Base User model."""

    id: models.ID
    email: EmailStr
    is_active: bool = True
    is_superuser: bool = False
    is_verified: bool = False
```

##### BaseUserCreate Class

**Class Description**: Model for creating users.

**API Summary**:

```python
class BaseUserCreate(CreateUpdateDictModel):
    email: EmailStr
    password: str
    is_active: Optional[bool] = True
    is_superuser: Optional[bool] = False
    is_verified: Optional[bool] = False
```

##### BaseUserUpdate Class

**Class Description**: Model for updating users.

**API Summary**:

```python
class BaseUserUpdate(CreateUpdateDictModel):
    password: Optional[str] = None
    email: Optional[EmailStr] = None
    is_active: Optional[bool] = None
    is_superuser: Optional[bool] = None
    is_verified: Optional[bool] = None
```

##### Authenticator Class

**Class Description**:
Provides dependency callables to retrieve authenticated user.
SECRET
It performs the authentication against a list of backends
defined by the end-developer. The first backend yielding a user wins.
If no backend yields a user, an HTTPException is raised.

:param backends: List of authentication backends.
:param get_user_manager: User manager dependency callable.

**API Summary**:

```python
class Authenticator(Generic[models.UP, models.ID]):

    def __init__(
        self,
        backends: Sequence[AuthenticationBackend[models.UP, models.ID]],
        get_user_manager: UserManagerDependency[models.UP, models.ID],
    ) -> None: ...
    def current_user_token(
        self,
        optional: bool = False,
        active: bool = False,
        verified: bool = False,
        superuser: bool = False,
        get_enabled_backends: Optional[EnabledBackendsDependency[models.UP, models.ID]] = None,
    ): ...
         @with_signature(signature)
        async def current_user_token_dependency(*args: Any, **kwargs: Any): ...
    def current_user(
        self,
        optional: bool = False,
        active: bool = False,
        verified: bool = False,
        superuser: bool = False,
        get_enabled_backends: Optional[EnabledBackendsDependency[models.UP, models.ID]] = None,
    ): ...
         @with_signature(signature)
        async def current_user_dependency(*args: Any, **kwargs: Any): ...
    async def _authenticate(
        self,
        *args,
        user_manager: BaseUserManager[models.UP, models.ID],
        optional: bool = False,
        active: bool = False,
        verified: bool = False,
        superuser: bool = False,
        **kwargs,
    ) -> tuple[Optional[models.UP], Optional[str]]:
    def _get_dependency_signature(
        self, get_enabled_backends: Optional[EnabledBackendsDependency] = None
    ) -> Signature: ...
```

**Main Method Descriptions**:

- **init**(backends, get_user_manager): Initializes an Authenticator instance with the authentication backend list and user manager dependency.
- current_user_token(optional, active, verified, superuser, get_enabled_backends): Returns a dependency call to retrieve the currently authenticated user and token. Optional specifies whether to return None if there is no authenticated user or other requirements are not met, default is False. Active specifies whether to raise a 401 unauthorized exception if the authenticated user is inactive, default is False. Verified specifies whether to raise a 401 unauthorized exception if the authenticated user is not verified, default is False. Superuser specifies whether to raise a 403 forbidden exception if the authenticated user is not a superuser, default is False. get_enabled_backends is an optional dependency call that returns a list of enabled authentication backends.
- current_user(optional, active, verified, superuser, get_enabled_backends): Returns a dependency call to retrieve the currently authenticated user. Parameter descriptions are the same as the current_user_token method.
- _get_dependency_signature(get_enabled_backends): Generates a dynamic signature for the current_user dependency.

##### StrategyDestroyNotSupportedError Class

**Class Description**: Exception raised when the authentication strategy does not support token destruction.

**API Summary**:

```python
class StrategyDestroyNotSupportedError(Exception):
    pass
```

##### Strategy Class

**Class Description**: Authentication strategy protocol.

**API Summary**:

```python
class Strategy(Protocol, Generic[models.UP, models.ID]):
    async def read_token(
        self, token: Optional[str], user_manager: BaseUserManager[models.UP, models.ID]
    ) -> Optional[models.UP]: ...
    async def write_token(self, user: models.UP) -> str: ...
    async def destroy_token(
        self, token: str, user: models.UP
    ) -> None: ...
```

**Main Method Descriptions**:

- read_token(token, user_manager): Reads a user from the token. Accepts an optional token and user manager, returns an optional user.
- write_token(user): Writes a token for the user. Accepts a user, returns a token string.
- destroy_token(token, user): Destroys the token. Accepts a token and user, returns no value.

##### RedisStrategy Class

**Class Description**: Redis authentication strategy implementation.

**API Summary**:

```python
class RedisStrategy(Strategy[models.UP, models.ID], Generic[models.UP, models.ID]):
    def __init__(
        self,
        redis: redis.asyncio.Redis,
        lifetime_seconds: Optional[int] = None,
        *,
        key_prefix: str = "fastapi_users_token:",
    ) : ...
    async def read_token(
        self, token: Optional[str], user_manager: BaseUserManager[models.UP, models.ID]
    ) -> Optional[models.UP]: ...
    async def write_token(self, user: models.UP) -> str: ...
    async def destroy_token(self, token: str, user: models.UP) -> None: ...
```

**Main Method Descriptions**:

- **init**(redis, lifetime_seconds, key_prefix): Initializes the Redis strategy with a Redis instance and optional lifetime.
- read_token(token, user_manager): Reads the token from Redis and retrieves the corresponding user.
- write_token(user): Generates a token for the user and stores it in Redis.
- destroy_token(token, user): Deletes the specified token from Redis.

##### TransportLogoutNotSupportedError Class

**Class Description**: Exception raised when the transport does not support logout.

**API Summary**:

```python
class TransportLogoutNotSupportedError(Exception):
    pass
```

##### Transport Class

**Class Description**: Authentication transport protocol.

**API Summary**:

```python
class Transport(Protocol):
    scheme: SecurityBase

    async def get_login_response(self, token: str) -> Response: ...
    async def get_logout_response(self) -> Response: ...
    @staticmethod
    def get_openapi_login_responses_success() -> OpenAPIResponseType: ...
    @staticmethod
    def get_openapi_logout_responses_success() -> OpenAPIResponseType: ...
```

**Main Method Descriptions**:

- get_login_response(token): Gets the login response. The parameter token is the authentication token, returns a FastAPI response object.
- get_logout_response(): Gets the logout response, returns a FastAPI response object.
- get_openapi_login_responses_success(): Returns a dictionary for OpenAPI login responses.
- get_openapi_logout_responses_success(): Returns a dictionary for OpenAPI logout responses.

##### BearerResponse Class

**Class Description**: Bearer authentication response model.

**API Summary**:

```python
class BearerResponse(BaseModel):
    access_token: str
    token_type: str
```

##### BaseUserDatabase Class

**Class Description**: Base adapter for retrieving, creating and updating users from a database.

**API Summary**:

```python
class BaseUserDatabase(Generic[UP, ID]):

    async def get(self, id: ID) -> Optional[UP]: ...
    async def get_by_email(self, email: str) -> Optional[UP]: ...
    async def get_by_oauth_account(self, oauth: str, account_id: str) -> Optional[UP]: ...
    async def create(self, create_dict: dict[str, Any]) -> UP: ...
    async def update(self, user: UP, update_dict: dict[str, Any]) -> UP: ...
    async def delete(self, user: UP) -> None: ...
    async def add_oauth_account(
        self: "BaseUserDatabase[UOAP, ID]", user: UOAP, create_dict: dict[str, Any]
    ) -> UOAP: ...
    async def update_oauth_account(
        self: "BaseUserDatabase[UOAP, ID]",
        user: UOAP,
        oauth_account: OAP,
        update_dict: dict[str, Any],
    ) -> UOAP: ...
```

**Main Method Descriptions**:

- get(id): Gets a single user by ID.
- get_by_email(email): Gets a single user by email.
- get_by_oauth_account(oauth, account_id): Gets a single user by OAuth account ID.
- create(create_dict): Creates a user.
- update(user, update_dict): Updates a user.
- delete(user): Deletes a user.
- add_oauth_account(user, create_dict): Creates an OAuth account and adds it to the user.
- update_oauth_account(user, oauth_account, update_dict): Updates an OAuth account on the user.

##### ErrorCode Class

**Class Description**: Error code enumeration.

**API Summary**:

```python
class ErrorCode(str, Enum):
    REGISTER_INVALID_PASSWORD = "REGISTER_INVALID_PASSWORD"
    REGISTER_USER_ALREADY_EXISTS = "REGISTER_USER_ALREADY_EXISTS"
    OAUTH_NOT_AVAILABLE_EMAIL = "OAUTH_NOT_AVAILABLE_EMAIL"
    OAUTH_USER_ALREADY_EXISTS = "OAUTH_USER_ALREADY_EXISTS"
    LOGIN_BAD_CREDENTIALS = "LOGIN_BAD_CREDENTIALS"
    LOGIN_USER_NOT_VERIFIED = "LOGIN_USER_NOT_VERIFIED"
    RESET_PASSWORD_BAD_TOKEN = "RESET_PASSWORD_BAD_TOKEN"
    RESET_PASSWORD_INVALID_PASSWORD = "RESET_PASSWORD_INVALID_PASSWORD"
    VERIFY_USER_BAD_TOKEN = "VERIFY_USER_BAD_TOKEN"
    VERIFY_USER_ALREADY_VERIFIED = "VERIFY_USER_ALREADY_VERIFIED"
    UPDATE_USER_EMAIL_ALREADY_EXISTS = "UPDATE_USER_EMAIL_ALREADY_EXISTS"
    UPDATE_USER_INVALID_PASSWORD = "UPDATE_USER_INVALID_PASSWORD"
```

##### AccessTokenDatabase Class

**Class Description**: Protocol for retrieving, creating and updating access tokens from the database.

**API Summary**:

```python
class AccessTokenDatabase(Protocol, Generic[AP]):
    """Protocol for retrieving, creating and updating access tokens from a database."""

    async def get_by_token(
        self, token: str, max_age: Optional[datetime] = None
    ) -> Optional[AP]: ...
    async def create(self, create_dict: dict[str, Any]) -> AP: ...
    async def update(self, access_token: AP, update_dict: dict[str, Any]) -> AP: ...
    async def delete(self, access_token: AP) -> None: ...
```

**Main Method Descriptions**:

- get_by_token(token, max_age): Gets a single access token by token. The parameter token is the token to retrieve, max_age is an optional maximum age timestamp. Returns an optional access token.
- create(create_dict): Creates an access token. The parameter create_dict is the dictionary for creating the token. Returns the created access token.
- update(access_token, update_dict): Updates an access token. The parameter access_token is the access token to update, update_dict is the update dictionary. Returns the updated access token.
- delete(access_token): Deletes an access token. The parameter access_token is the access token to delete.

##### AccessTokenProtocol Class

**Class Description**: Access token protocol that ORM models should follow.

**API Summary**:

```python
class AccessTokenProtocol(Protocol[models.ID]):
    """Access token protocol that ORM model should follow."""

    token: str
    user_id: models.ID
    created_at: datetime
```

##### DatabaseStrategy Class

**Class Description**: Database authentication strategy implementation.

**API Summary**:

```python
class DatabaseStrategy(
    Strategy[models.UP, models.ID], Generic[models.UP, models.ID, AP]
):
    def __init__(
        self, database: AccessTokenDatabase[AP], lifetime_seconds: Optional[int] = None
    ): ...
    async def read_token(
        self, token: Optional[str], user_manager: BaseUserManager[models.UP, models.ID]
    ) -> Optional[models.UP]: ...
    async def write_token(self, user: models.UP) -> str: ...
    async def destroy_token(self, token: str, user: models.UP) -> None: ...
    def _create_access_token_dict(self, user: models.UP) -> dict[str, Any]: ...
```

**Main Method Descriptions**:

- **init**(database, lifetime_seconds): Initializes the database strategy with an access token database and optional lifetime.
- read_token(token, user_manager): Reads a user from the token. The parameter token is an optional token, user_manager is the user manager. Returns an optional user.
- write_token(user): Writes a token for the user. The parameter user is the user to write the token for. Returns a token string.
- destroy_token(token, user): Destroys the token. The parameter token is the token to destroy, user is the corresponding user.
- _create_access_token_dict(user): Internal method to create an access token dictionary for the user. The parameter user is the user to create the token dictionary for. Returns a dictionary containing the token and user ID.


#### Functions

##### _get_secret_value Function

**Function description**: Extracts the actual secret value from a SecretType (either string or SecretStr object). This function handles both string and SecretStr types, returning the actual secret value as a string.

**Function Signature**:

```python
def _get_secret_value(secret: SecretType) -> str: ...
```

**Parameters**:

- `secret` (SecretType): The secret value, can be either a string or SecretStr object

**Returns**:

- `str`: The actual secret value as a string

##### generate_jwt Function

**Function description**: Generates a JWT token with the provided data, secret, lifetime, and algorithm. This function creates a JWT token by encoding the provided data along with an optional expiration time.

**Function Signature**:

```python
def generate_jwt(
    data: dict,
    secret: SecretType,
    lifetime_seconds: Optional[int] = None,
    algorithm: str = JWT_ALGORITHM,
) -> str:
```

**Parameters**:

- `data` (dict): The payload data to be encoded in the JWT
- `secret` (SecretType): The secret key used for encoding the JWT
- `lifetime_seconds` (Optional[int]): The lifetime of the token in seconds, if None the token will not expire, default is None
- `algorithm` (str): The algorithm used for encoding, defaults to "HS256"

**Returns**:

- `str`: The encoded JWT token as a string

##### decode_jwt Function

**Function description**: Decodes a JWT token with the provided secret, audience, and algorithms. This function verifies and decodes a JWT token, checking that it matches the expected audience.

**Function Signature**:

```python
def decode_jwt(
    encoded_jwt: str,
    secret: SecretType,
    audience: list[str],
    algorithms: list[str] = [JWT_ALGORITHM],
) -> dict[str, Any]:
```

**Parameters**:

- `encoded_jwt` (str): The JWT token to be decoded
- `secret` (SecretType): The secret key used for decoding the JWT
- `audience` (list[str]): A list of valid audiences for the token
- `algorithms` (list[str]): A list of valid algorithms for the token, defaults to ["HS256"]

**Returns**:

- `dict[str, Any]`: The decoded JWT payload as a dictionary containing the original data and metadata

##### name_to_variable_name Function

**Function description**: Transforms a backend name string into a string safe to use as a variable name. This function removes invalid characters and leading non-alphabetic characters to create a valid Python variable name from the provided backend name.

**Function Signature**:

```python
def name_to_variable_name(name: str) -> str: ...
```

**Parameters**:

- `name` (str): The backend name string to be converted

**Returns**:

- `str`: A safe variable name with invalid characters removed

##### name_to_strategy_variable_name Function

**Function description**: Transforms a backend name string into a strategy variable name by prefixing it with 'strategy_'. This function first converts the backend name to a safe variable name and then adds a 'strategy_' prefix.

**Function Signature**:

```python
def name_to_strategy_variable_name(name: str) -> str:
```

**Parameters**:

- `name` (str): The backend name string to be converted

**Returns**:

- `str`: A strategy variable name with "strategy_" prefix

##### generate_state_token Function

**Function description**: Generates a state token for OAuth flows with the provided data, secret, and lifetime. This function creates a JWT token with a specific audience for OAuth state management to prevent CSRF attacks.

**Function Signature**:

```python
def generate_state_token(
    data: dict[str, str], secret: SecretType, lifetime_seconds: int = 3600
) -> str:
```

**Parameters**:

- `data` (dict[str, str]): The data to be included in the state token
- `secret` (SecretType): The secret key used for encoding the JWT
- `lifetime_seconds` (int): The lifetime of the token in seconds, defaults to 3600

**Returns**:

- `str`: The encoded state token as a JWT string

##### get_oauth_associate_router Function

**Function description**: Generates a router with the OAuth routes to associate an authenticated user with an OAuth account. This function creates endpoints for OAuth flows that allow an already authenticated user to link their account with an OAuth provider.

**Function Signature**:

```python
def get_oauth_associate_router(
    oauth_client: BaseOAuth2,
    authenticator: Authenticator[models.UP, models.ID],
    get_user_manager: UserManagerDependency[models.UP, models.ID],
    user_schema: type[schemas.U],
    state_secret: SecretType,
    redirect_url: Optional[str] = None,
    requires_verification: bool = False,
) -> APIRouter:
```

**Parameters**:

- `oauth_client` (BaseOAuth2): The OAuth client instance for the specific provider
- `authenticator` (Authenticator[models.UP, models.ID]): The authenticator instance
- `get_user_manager` (UserManagerDependency[models.UP, models.ID]): A dependency callable to get the user manager
- `user_schema` (type[schemas.U]): The user schema for response serialization
- `state_secret` (SecretType): The secret key for encoding state tokens
- `redirect_url` (Optional[str]): The redirect URL for the OAuth flow, defaults to callback endpoint, default is None
- `requires_verification` (bool): Whether email verification is required, default is False

**Returns**:

- `APIRouter`: A FastAPI router instance containing the OAuth associate routes

#### Type Aliases

##### __version__

- **Description**: A string constant representing the version number of the FastAPI-Users library. This follows semantic versioning and indicates the current release version of the package.
- **Value**: `"14.0.1"`

##### __all__ (fastapi_users/__init__.py)

- **Description**: An export list that defines which modules and classes are publicly accessible when using `from fastapi_users import *`. This controls the public API surface of the main fastapi_users module.
- **Value**: `["models", "schemas", "FastAPIUsers", "BaseUserManager", "InvalidPasswordException", "InvalidID", "UUIDIDMixin", "IntegerIDMixin"]`

##### __all__ (fastapi_users/authentication/__init__.py)

- **Description**: An export list that defines which authentication-related classes and transports are publicly accessible when using `from fastapi_users.authentication import *`. This controls the public API surface of the authentication module.
- **Value**: `["Authenticator", "AuthenticationBackend", "BearerTransport", "CookieTransport", "JWTStrategy", "RedisStrategy", "Strategy", "Transport"]`

##### __all__ (fastapi_users/authentication/strategy/__init__.py)

- **Description**: An export list that defines which authentication strategy classes are publicly accessible when using `from fastapi_users.authentication.strategy import *`. This controls the public API surface of the strategy module.
- **Value**: `["AP", "AccessTokenDatabase", "AccessTokenProtocol", "DatabaseStrategy", "JWTStrategy", "Strategy", "StrategyDestroyNotSupportedError", "RedisStrategy"]`

##### __all__ (fastapi_users/authentication/strategy/db/__init__.py)

- **Description**: An export list that defines which database authentication strategy components are publicly accessible when using `from fastapi_users.authentication.strategy.db import *`. This controls the public API surface of the database strategy module.
- **Value**: `["AP", "AccessTokenDatabase", "AccessTokenProtocol", "DatabaseStrategy"]`

##### __all__ (fastapi_users/authentication/transport/__init__.py)

- **Description**: An export list that defines which authentication transport classes are publicly accessible when using `from fastapi_users.authentication.transport import *`. This controls the public API surface of the transport module.
- **Value**: `["BearerTransport", "CookieTransport", "Transport", "TransportLogoutNotSupportedError"]`

##### UserDatabaseDependency

- **Description**: A type alias representing a dependency callable for the BaseUserDatabase class. This is used for dependency injection to provide a database interface for user operations in the FastAPI-Users framework.
- **Value**: `DependencyCallable[BaseUserDatabase[UP, ID]]`

##### __all__ (fastapi_users/db/__init__.py)

- **Description**: An export list that defines which database-related components are publicly accessible when using `from fastapi_users.db import *`. This controls the public API surface of the database module, including extensions for SQLAlchemy and Beanie if available.
- **Value**: `["BaseUserDatabase", "UserDatabaseDependency", "SQLAlchemyBaseUserTable", "SQLAlchemyBaseUserTableUUID", "SQLAlchemyBaseOAuthAccountTable", "SQLAlchemyBaseOAuthAccountTableUUID", "SQLAlchemyUserDatabase", "BeanieBaseUser", "BaseOAuthAccount", "BeanieUserDatabase", "ObjectIDIDMixin"]` (with conditional inclusion of database extensions)

##### __all__ (fastapi_users/router/__init__.py)

- **Description**: An export list that defines which router components are publicly accessible when using `from fastapi_users.router import *`. This controls the public API surface of the router module, providing functions to create various user management route handlers.
- **Value**: `["ErrorCode", "get_auth_router", "get_register_router", "get_reset_password_router", "get_users_router", "get_verify_router", "get_oauth_router"]` (with conditional inclusion of OAuth router)

## DuplicateBackendNamesError Class

**Class Description**: Exception raised when authentication backend names are duplicated.

**API Summary**:

```python
class DuplicateBackendNamesError(Exception):
    pass
```

#### 19. ErrorModel - Error Response Model

**Class Description**: Error response model.

**API Summary**:

```python
class ErrorModel(BaseModel):
    detail: Union[str, dict[str, str]]
```

#### 20. ErrorCodeReasonModel - Error Code Reason Model

**Class Description**: Error code and reason model.

**API Summary**:

```python
class ErrorCodeReasonModel(BaseModel):
    code: str
    reason: str
```

#### 21. JWTStrategyDestroyNotSupportedError - JWT Strategy Destroy Not Supported Error

**Class Description**: Exception raised when JWT strategy does not support token destruction.

**API Summary**:

```python
class JWTStrategyDestroyNotSupportedError(StrategyDestroyNotSupportedError):
    def __init__(self) -> None: ...
```

**Main Method Descriptions**:

- __init__(): Initializes the exception, indicating that JWT cannot be invalidated: it remains valid until expiration.

#### 22. OAuth2AuthorizeResponse - OAuth2 Authorization Response Model

**Class Description**: OAuth2 authorization response model.

**API Summary**:

```python
class OAuth2AuthorizeResponse(BaseModel):
    authorization_url: str
```

**Parameter Description**:
- `authorization_url`: OAuth2 authorization URL

**Return Value**: OAuth2 authorization response model definition.


### Detailed Description of Configuration Classes

#### 1. AuthenticationBackend

**Class Description**: 
Combination of an authentication transport and strategy.

Together, they provide a full authentication method logic.

:param name: Name of the backend.
:param transport: Authentication transport instance.
:param get_strategy: Dependency callable returning
an authentication strategy instance.

**API Summary**:

```python
class AuthenticationBackend(Generic[models.UP, models.ID]):

    def __init__(
        self,
        name: str,
        transport: Transport,
        get_strategy: DependencyCallable[Strategy[models.UP, models.ID]],
    ): ...
    async def login(
        self, strategy: Strategy[models.UP, models.ID], user: models.UP
    ) -> Response: ...
    async def logout(
        self, strategy: Strategy[models.UP, models.ID], user: models.UP, token: str
    ) -> Response: ...
```

**Main Method Descriptions**:

- __init__(name, transport, get_strategy): Initializes the authentication backend with a name, transport, and dependency call to get the strategy.
- login(strategy, user): Performs login using the specified strategy and user, returns the login response.
- logout(strategy, user, token): Performs logout using the specified strategy, user, and token, returns the logout response.

#### 2. JWTStrategy

**Class Description**: JWT authentication strategy implementation.

**API Summary**:

```python
class JWTStrategy(Strategy[models.UP, models.ID], Generic[models.UP, models.ID]):
    def __init__(
        self,
        secret: SecretType,
        lifetime_seconds: Optional[int],
        token_audience: list[str] = ["fastapi-users:auth"],
        algorithm: str = "HS256",
        public_key: Optional[SecretType] = None,
    ): ...
    @property
    def encode_key(self) -> SecretType: ...
    @property
    def decode_key(self) -> SecretType: ...
    async def read_token(
        self, token: Optional[str], user_manager: BaseUserManager[models.UP, models.ID]
    ) -> Optional[models.UP]: ...
    async def write_token(self, user: models.UP) -> str: ...
    async def destroy_token(self, token: str, user: models.UP) -> None: ...
```

**Main Method Descriptions**:

- __init__(secret, lifetime_seconds, token_audience, algorithm, public_key): Initializes a JWT strategy instance with the specified parameters.
- encode_key: Gets the key for encoding.
- decode_key: Gets the key for decoding.
- read_token(token, user_manager): Reads a user from the token.
- write_token(user): Writes a token for the user.
- destroy_token(token, user): Destroys the token, but throws a JWTStrategyDestroyNotSupportedError exception due to JWT characteristics.

#### 3. BearerTransport

**Class Description**: Bearer authentication transport implementation.

**API Summary**:

```python
class BearerTransport(Transport):
    scheme: OAuth2PasswordBearer

    def __init__(self, tokenUrl: str) -> None: ...
    async def get_login_response(self, token: str) -> Response: ...
    async def get_logout_response(self) -> Response: ...
    @staticmethod
    def get_openapi_login_responses_success() -> OpenAPIResponseType: ...
    @staticmethod
    def get_openapi_logout_responses_success() -> OpenAPIResponseType: ...
```

**Main Method Descriptions**:

- __init__(tokenUrl): Initializes the Bearer transport with the token URL.
- get_login_response(token): Gets the login response.
- get_logout_response(): Gets the logout response, but throws a TransportLogoutNotSupportedError exception because Bearer transport does not support logout.
- get_openapi_login_responses_success(): Returns the login success response definition for OpenAPI documentation.
- get_openapi_logout_responses_success(): Returns the logout success response definition for OpenAPI documentation.

#### 4. CookieTransport
## CookieTransport Class

**Class Description**: Cookie authentication transport implementation.

**API Summary**:

```python
class CookieTransport(Transport):
    scheme: APIKeyCookie

    def __init__(
        self,
        cookie_name: str = "fastapiusersauth",
        cookie_max_age: Optional[int] = None,
        cookie_path: str = "/",
        cookie_domain: Optional[str] = None,
        cookie_secure: bool = True,
        cookie_httponly: bool = True,
        cookie_samesite: Literal["lax", "strict", "none"] = "lax",
    ): ...
    async def get_login_response(self, token: str) -> Response: ...
    async def get_logout_response(self) -> Response: ...
    def _set_login_cookie(self, response: Response, token: str) -> Response: ...
    def _set_logout_cookie(self, response: Response) -> Response: ...
    @staticmethod
    def get_openapi_login_responses_success() -> OpenAPIResponseType: ...
    @staticmethod
    def get_openapi_logout_responses_success() -> OpenAPIResponseType: ...
```

**Main Method Descriptions**:

- __init__(cookie_name, cookie_max_age, cookie_path, cookie_domain, cookie_secure, cookie_httponly, cookie_samesite): Initializes the Cookie transport with the specified Cookie parameters.
- get_login_response(token): Gets the login response, sets the authentication cookie.
- get_logout_response(): Gets the logout response, clears the authentication cookie.
- _set_login_cookie(response, token): Internal method to set the login cookie.
- _set_logout_cookie(response): Internal method to set the logout cookie (clears the cookie).
- get_openapi_login_responses_success(): Returns the login success response definition for OpenAPI documentation.
- get_openapi_logout_responses_success(): Returns the logout success response definition for OpenAPI documentation.

### Actual Usage Patterns

### Supported Authentication Strategies

- **JWT Strategy**: Stateless authentication based on JSON Web Tokens.
- **Database Strategy**: Store tokens in the database, supporting token revocation.
- **Redis Strategy**: Use Redis to store tokens, supporting distributed deployment.

### Supported Transport Methods

- **Bearer Transport**: Transmit tokens through the HTTP Authorization header.
- **Cookie Transport**: Transmit tokens through HTTP Cookies, suitable for browser environments.

### Error Handling

The system provides a complete error handling mechanism:
- **Authentication Exceptions**: Handle authentication errors such as invalid tokens and expired tokens.
- **User Exceptions**: Handle user status errors such as user not found and user inactive.
- **Permission Exceptions**: Handle permission-related errors such as insufficient permissions and verification required.
- **OAuth Exceptions**: Handle various errors in the OAuth process.

### Important Notes

1. **Asynchronous Support**: All core functions support asynchronous operations to ensure high performance.
2. **Type Safety**: Use generics to provide complete type hints and checks.
3. **Extensibility**: Support custom user models, authentication strategies, and transport methods.
4. **Security**: Built-in multiple security mechanisms, such as token expiration and password hashing.
5. **Compatibility**: Fully compatible with the FastAPI ecosystem, supporting dependency injection.

