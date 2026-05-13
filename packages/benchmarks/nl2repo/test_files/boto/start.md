## Introduction and Goals of the Boto3 Project

Boto3 is the **official Python SDK for Amazon Web Services (AWS)**, providing Python developers with a comprehensive toolkit to interact with AWS cloud services. This library allows developers to write software that can utilize AWS services such as Amazon S3, Amazon EC2, and Amazon DynamoDB, supporting both resource-oriented APIs and low-level service access. Maintained and released by Amazon Web Services, Boto3 offers full coverage of AWS services, including computing, storage, databases, networking, security, artificial intelligence, and other fields. Its core features include: **Creation of AWS service clients** (supporting the instantiation of clients for all AWS services), **Resource-oriented programming** (providing high-level resource abstractions to simplify common operations), **Session management** (unified credential and configuration management), and **Automatic retry and error handling** (built-in fault tolerance mechanisms). In short, Boto3 aims to provide Python developers with a powerful, easy-to-use, and fully functional interface to access AWS cloud services. With a simple `import boto3`, developers can start using various AWS cloud services.

## Natural Language Instruction (Prompt)

Please create a Python project named Boto3 to implement a complete AWS cloud service access SDK. The project should include the following features:

1. Session Management System: Implement the `Session` class to manage AWS credentials, region configurations, and user agent settings. It should support multiple credential configuration methods (access keys, session tokens, account IDs), provide methods such as `get_credentials()`, `get_available_services()`, `get_available_resources()`, `get_available_regions()`, and support configuration file management and custom user agents.

2. Client Creation Mechanism: Implement the `client()` function to create low-level clients for all AWS services. It should support parameters such as service name, region, API version, SSL configuration, and endpoint URL, providing full coverage of AWS services, including S3, EC2, DynamoDB, SQS, SNS, and all other AWS services.

3. Resource-Oriented Programming: Implement the `resource()` function to provide a high-level resource abstraction interface. It should support resource collections, operations, sub-resources, etc. Dynamically create resource objects through the `ResourceFactory` class, and support resource-level operations such as `load()`, `reload()`, `wait_until()`, etc.

4. S3 Transfer Function: Implement a high-level abstraction for S3 file transfer, including the `S3Transfer` class and the `TransferConfig` configuration class. It should support single-part and multi-part uploads/downloads, progress callbacks, retry mechanisms, parallel transfers, etc., provide methods such as `upload_file()`, `download_file()`, `copy()`, and support custom transfer configurations and progress monitoring.

5. DynamoDB Condition Expressions: Implement a system for building DynamoDB query conditions, including the `Attr`, `Key` classes, and various conditional operators. It should support operations such as equal to, not equal to, greater than, less than, contains, begins with, and existence checks, provide methods such as `eq()`, `lt()`, `gt()`, `contains()`, `begins_with()`, `between()`, and support the combination of complex conditional expressions.

6. EC2 Tag Management: Implement tag operation functions for EC2 instances, including the `create_tags()` and `delete_tags()` methods. It should support batch tag creation and deletion, provide tag filtering and query functions, and support the verification and management of tag key-value pairs.

7. CRT Transfer Manager: Implement a high-performance transfer manager based on AWS CRT, providing the `CRTTransferManager` class. It should support S3 transfer optimization, connection pool management, concurrency control, etc., and provide a compatibility interface with the standard transfer manager.

8. Exception Handling System: Implement a complete exception handling mechanism, including custom exception classes such as `ResourceNotExistsError`, `UnknownAPIVersionError`, `DynamoDBNeedsConditionError`. It should provide clear error messages and an exception hierarchy, supporting the classification and handling of exceptions.

9. Utility Function Collection: Implement various utility functions, including `inject_attributes()`, `import_module()`, `lazy_call()`, etc. It should support dynamic attribute injection, module import, lazy loading, etc., providing development assistance tools.

10. Documentation Generation System: Implement an automatic documentation generation function, including service documentation, resource documentation, method documentation, etc. It should support the generation of RST-format documentation, providing full coverage of API documentation, including sample code and parameter descriptions.

11. Testing Framework Support: Implement a complete testing support system, including unit tests, functional tests, integration tests, etc. It should support the creation tests of clients and resources for all AWS services, providing functions such as API version synchronization verification and service availability checks.

12. Configuration Management: Implement a flexible configuration management system, supporting multiple methods such as environment variables, configuration files, and code configurations. It should provide default configurations, custom configurations, and configuration verification functions, supporting configuration switching in different environments.

The above features need to be combined to build a complete AWS SDK toolkit. The project should ultimately include modules such as session management, client creation, resource abstraction, service customization, transfer optimization, condition building, and documentation generation, along with complete test cases, forming a reproducible AWS cloud service access process.

13. Core document requirement: The project must include a complete 'pyproject.toml' file. This file should not only configure the project as an installable package (supporting "pip installation"), but also declare a complete list of dependencies (including core libraries such as "botocore>=1.39.16,<1.40.0", "jmespath>=0.7.1,<2.0.0", "s3transfer>=0.13.0,<0.14.0"). Meanwhile, it is necessary to provide 'boto3/__init__. py' as a unified API entry point for importing` ResourceNotExistsError`、`ResourceLoadException`、`DynamoDBNeedsConditionError`、` DynamoDBNeedsKeyConditionError'、`Dynamo DBOperationNotSupportedError`、'TransferConfig`、`create_transfer_manager`、`has_minimum_crt_version`、`AnamoDBHighLevelResource`、`ParameterTransformer`、`TransformationInjector`、`copy_dymodb_params`、`register_high_level_interface` Wait for core classes and functions, and provide version information. Enable users to access all major features through simple statements, such as "import boto3" and "from boto3. pat/observations/s3/dymodb/ec2/resources/docs/import * *". In 'session. py', there should be a 'session' class to manage AWS sessions and credentials. In 'resources/factory. py', there should be a 'ResourceFactory' class to dynamically create resource objects. In 's3/transfer. py', there should be a 'S3Transfer' class to handle s3 file transfer operations. *`.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python Python 3.11.7

### Optional Dependencies

**awscrt>=0.19.18** (AWS Common Runtime for Python):
- Optional dependency that enables CRT-based high-performance S3 transfers with improved throughput and lower CPU usage
- If not installed, boto3 automatically falls back to classic transfer manager
- The code uses `HAS_CRT` flag from `botocore.compat` to check availability and gracefully degrades when awscrt is not present
- No errors will occur if awscrt is missing; CRT-accelerated transfers simply won't be available

### Core Dependency Library Versions

```Plain
pip        23.2.1
setuptools 65.5.1
wheel      0.42.0
```

## Boto3 Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .coveragerc
├── .gitignore
├── .pre-commit-config.yaml
├── CHANGELOG.rst
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.rst
├── LICENSE
├── MANIFEST.in
├── NOTICE
├── README.rst
├── boto3
│   ├── __init__.py
│   ├── compat.py
│   ├── crt.py
│   ├── data
│   │   ├── cloudformation
│   │   │   ├── 2010-05-15
│   │   │   │   └── resources-1.json
│   │   ├── cloudwatch
│   │   │   ├── 2010-08-01
│   │   │   │   └── resources-1.json
│   │   ├── dynamodb
│   │   │   ├── 2012-08-10
│   │   │   │   └── resources-1.json
│   │   ├── ec2
│   │   │   ├── 2014-10-01
│   │   │   │   ├── resources-1.json
│   │   │   ├── 2015-03-01
│   │   │   │   ├── resources-1.json
│   │   │   ├── 2015-04-15
│   │   │   │   ├── resources-1.json
│   │   │   ├── 2015-10-01
│   │   │   │   ├── resources-1.json
│   │   │   ├── 2016-04-01
│   │   │   │   ├── resources-1.json
│   │   │   ├── 2016-09-15
│   │   │   │   ├── resources-1.json
│   │   │   ├── 2016-11-15
│   │   │   │   └── resources-1.json
│   │   ├── glacier
│   │   │   ├── 2012-06-01
│   │   │   │   └── resources-1.json
│   │   ├── iam
│   │   │   ├── 2010-05-08
│   │   │   │   └── resources-1.json
│   │   ├── s3
│   │   │   ├── 2006-03-01
│   │   │   │   └── resources-1.json
│   │   ├── sns
│   │   │   ├── 2010-03-31
│   │   │   │   └── resources-1.json
│   │   ├── sqs
│   │   │   └── 2012-11-05
│   │   │       └── resources-1.json
│   ├── docs
│   │   ├── __init__.py
│   │   ├── action.py
│   │   ├── attr.py
│   │   ├── base.py
│   │   ├── client.py
│   │   ├── collection.py
│   │   ├── docstring.py
│   │   ├── method.py
│   │   ├── resource.py
│   │   ├── service.py
│   │   ├── subresource.py
│   │   ├── utils.py
│   │   ├── waiter.py
│   ├── dynamodb
│   │   ├── __init__.py
│   │   ├── conditions.py
│   │   ├── table.py
│   │   ├── transform.py
│   │   ├── types.py
│   ├── ec2
│   │   ├── __init__.py
│   │   ├── createtags.py
│   │   ├── deletetags.py
│   ├── examples
│   │   ├── cloudfront.rst
│   │   ├── s3.rst
│   ├── exceptions.py
│   ├── resources
│   │   ├── __init__.py
│   │   ├── action.py
│   │   ├── base.py
│   │   ├── collection.py
│   │   ├── factory.py
│   │   ├── model.py
│   │   ├── params.py
│   │   ├── response.py
│   ├── s3
│   │   ├── __init__.py
│   │   ├── constants.py
│   │   ├── inject.py
│   │   ├── transfer.py
│   ├── session.py
│   ├── utils.py
├── docs
│   ├── Makefile
│   ├── README.rst
│   ├── make.bat
│   ├── source
│   │   ├── _static
│   │   │   ├── 404.html
│   │   │   ├── css
│   │   │   │   ├── custom.css
│   │   │   │   ├── dark_light_mode.css
│   │   │   ├── js
│   │   │   │   ├── custom.js
│   │   │   ├── logos
│   │   │   │   ├── aws_dark_theme_logo.svg
│   │   │   │   └── aws_light_theme_logo.svg
│   │   ├── _templates
│   │   │   ├── globaltoc.html
│   │   │   ├── page.html
│   │   │   ├── partials
│   │   │   │   ├── _head_css_variables.html
│   │   │   │   ├── icons.html
│   │   │   ├── sidebar
│   │   │   │   ├── close-icon.html
│   │   │   │   └── feedback.html
│   │   ├── conf.py
├── pyproject.toml
├── readthedocs.yml
├── scripts
│   ├── ci
│   │   ├── install
│   │   ├── install-dev-deps
│   │   ├── run-crt-tests
│   │   ├── run-integ-tests
│   │   ├── run-tests
│   ├── new-change
└── tox.ini

```

## API Usage Guide

### Core APIs

#### 1. Module Import

```python
# Complete import list after deduplication and merging (grouped by modules, retaining semantics)
import boto3
from boto3 import __version__, utils
from boto3.session import Session
from boto3.compat import collections_abc
from boto3.exceptions import (
    ResourceNotExistsError,ResourceLoadException,DynamoDBNeedsConditionError,DynamoDBNeedsKeyConditionError,DynamoDBOperationNotSupportedError,
)
# S3 & Transfer related
from boto3.s3 import inject
from boto3.s3.transfer import (
    TransferConfig,create_transfer_manager,has_minimum_crt_version,
)

# DynamoDB
from boto3.dynamodb.conditions import (
    Attr,Key,And,AttributeExists,AttributeNotExists,AttributeType,BeginsWith,Between,ConditionExpressionBuilder,Contains,Equals,GreaterThan,GreaterThanEquals,
    In,LessThan,LessThanEquals,Not,NotEquals,Or,Size,
)
from boto3.dynamodb.table import BatchWriter
from boto3.dynamodb.types import Binary, TypeDeserializer, TypeSerializer
from boto3.dynamodb.transform import (
    DynamoDBHighLevelResource,ParameterTransformer,TransformationInjector,copy_dynamodb_params,register_high_level_interface,
)

# EC2
from boto3.ec2 import createtags
from boto3.ec2.deletetags import delete_tags

# Resource model & Factory
from boto3.resources.base import (
    ResourceMeta,ServiceResource,
)
from boto3.resources.collection import (
    CollectionManager,ResourceCollection,CollectionFactory,
)
from boto3.resources.factory import ResourceFactory
from boto3.resources.model import (
    Action,Collection,Parameter,Request,ResourceModel,ResponseResource,Waiter,
)
from boto3.resources.action import (
    BatchAction,ServiceAction,WaiterAction,
)
from boto3.resources.response import (
    RawHandler,ResourceHandler,build_empty_response,build_identifiers,
)
from boto3.resources.params import (
    build_param_structure,create_request_parameters,
)

# Documentation
from boto3.docs.action import (
    ActionDocumenter,PUT_DATA_WARNING_MESSAGE,
)
from boto3.docs.attr import document_attribute
from boto3.docs.client import Boto3ClientDocumenter
from boto3.docs.collection import CollectionDocumenter
from boto3.docs.resource import (
    ResourceDocumenter,ServiceResourceDocumenter,
)
from boto3.docs.service import ServiceDocumenter
from boto3.docs.subresource import SubResourceDocumenter
from boto3.docs.utils import get_resource_ignore_params
from boto3.docs.waiter import WaiterResourceDocumenter

```

#### 2. Session Class

**Function Description**: Session management class for AWS credentials, region configurations, and user agent settings.

**Import Method**:
```python
from boto3.session import Session
```

**Class Signature**:
```python
class Session:
    """
    A session stores configuration state and allows you to create service
    clients and resources.

    :type aws_access_key_id: string
    :param aws_access_key_id: AWS access key ID
    :type aws_secret_access_key: string
    :param aws_secret_access_key: AWS secret access key
    :type aws_session_token: string
    :param aws_session_token: AWS temporary session token
    :type region_name: string
    :param region_name: Default region when creating new connections
    :type botocore_session: botocore.session.Session
    :param botocore_session: Use this Botocore session instead of creating
                             a new default one.
    :type profile_name: string
    :param profile_name: The name of a profile to use. If not given, then
                         the default profile is used.
    :type aws_account_id: string
    :param aws_account_id: AWS account ID
    """
    
    resource_factory: ResourceFactory
    
    def __init__(
        self,
        aws_access_key_id=None,
        aws_secret_access_key=None,
        aws_session_token=None,
        region_name=None,
        botocore_session=None,
        profile_name=None,
        aws_account_id=None,
    )
    
    def __repr__(self):
        return '{}(region_name={})'.format(
            self.__class__.__name__,
            repr(self._session.get_config_variable('region')),
        )
    
    @property
    def profile_name(self) -> str
    
    @property
    def region_name(self) -> str
    
    @property
    def events(self)
    
    @property
    def available_profiles(self) -> list[str]
    
    def _setup_loader(self) -> None
    
    def get_available_services(self) -> list[str]
    
    def get_available_resources(self) -> list[str]
    
    def get_available_partitions(self) -> list[str]
    
    def get_available_regions(
        self, 
        service_name, 
        partition_name='aws', 
        allow_non_regional=False
    ) -> list[str]
    
    def get_credentials(self) -> botocore.credentials.Credentials
    
    def get_partition_for_region(self, region_name: str) -> str
    
    def client(
        self,
        service_name,
        region_name=None,
        api_version=None,
        use_ssl=True,
        verify=None,
        endpoint_url=None,
        aws_access_key_id=None,
        aws_secret_access_key=None,
        aws_session_token=None,
        config=None,
        aws_account_id=None,
    ) -> BaseClient
    
    def resource(
        self,
        service_name,
        region_name=None,
        api_version=None,
        use_ssl=True,
        verify=None,
        endpoint_url=None,
        aws_access_key_id=None,
        aws_secret_access_key=None,
        aws_session_token=None,
        config=None,
    ) -> ServiceResource
    
    def _register_default_handlers(self) -> None
    
    def _account_id_set_without_credentials(
        self,
        *,
        aws_account_id,
        aws_access_key_id,
        aws_secret_access_key,
        **kwargs,
    ) -> bool
```

**Parameters** (__init__ parameters):
- `aws_access_key_id` (str, optional): AWS access key ID for authentication
- `aws_secret_access_key` (str, optional): AWS secret access key for authentication
- `aws_session_token` (str, optional): AWS session token for temporary credentials
- `region_name` (str, optional): AWS region name (e.g., 'us-west-2')
- `botocore_session` (botocore.session.Session, optional): Existing botocore session object to use instead of creating a new one
- `profile_name` (str, optional): AWS configuration profile name from ~/.aws/config
- `aws_account_id` (str, optional): AWS account ID

**Instance Attributes** (set during initialization):
- `_session` (botocore.session.Session): Internal botocore session object
- `resource_factory` (ResourceFactory): ResourceFactory instance for creating resources
- `_loader` (DataLoader): Data loader for loading resource definitions

**Properties** (read-only attributes):
- `profile_name` (str): The profile name used by the session (defaults to 'default')
- `region_name` (str): The region name configured for the session
- `events` (EventEmitter): The event emitter for the session
- `available_profiles` (list[str]): List of available credential profiles

**Main Methods**:

**get_available_services()**: Get a list of available services that can be loaded as low-level clients via :py:meth:`Session.client`.
- Returns: list - List of service names

**get_available_resources()**: Get a list of available services that can be loaded as resource clients via :py:meth:`Session.resource`.
- Returns: list - List of service names

**get_available_partitions()**: Lists the available partitions
- Returns: list - Returns a list of partition names (e.g., ["aws", "aws-cn"])

**get_available_regions()**: Lists the region and endpoint names of a particular partition. The list of regions returned by this method are regions that are explicitly known by the client to exist and is not comprehensive. A region not returned in this list may still be available for the provided service.
- Parameters:
  - `service_name` (string): Name of a service to list endpoint for (e.g., s3).
  - `partition_name` (string): Name of the partition to limit endpoints to. (e.g., aws for the public AWS endpoints, aws-cn for AWS China endpoints, aws-us-gov for AWS GovCloud (US) Endpoints, etc.)
  - `allow_non_regional` (bool): Set to True to include endpoints that are not regional endpoints (e.g., s3-external-1, fips-us-gov-west-1, etc).
- Returns: list - Returns a list of endpoint names (e.g., ["us-east-1"]).

**get_credentials()**: Return the :class:`botocore.credentials.Credentials` object associated with this session.  If the credentials have not yet been loaded, this will attempt to load them.  If they have already been loaded, this will return the cached credentials.
- Returns: :class:`botocore.credentials.Credentials` object

**get_partition_for_region()**: Lists the partition name of a particular region.
- Parameters:
  - `region_name` (string): Name of the region to list partition for (e.g., us-east-1).
- Returns: string - Returns the respective partition name (e.g., aws).

**client()**: Create a low-level service client by name.
- Parameters:
  - `service_name` (string): The name of a service, e.g. 's3' or 'ec2'. You can get a list of available services via :py:meth:`get_available_services`.
  - `region_name` (string, optional): The name of the region associated with the client. A client is associated with a single region.
  - `api_version` (string, optional): The API version to use. By default, botocore will use the latest API version when creating a client. You only need to specify this parameter if you want to use a previous API version of the client.
  - `use_ssl` (boolean, optional): Whether or not to use SSL. By default, SSL is used. Note that not all services support non-ssl connections.
  - `verify` (boolean/string, optional): Whether or not to verify SSL certificates. By default SSL certificates are verified. You can provide the following values: False - do not validate SSL certificates. SSL will still be used (unless use_ssl is False), but SSL certificates will not be verified; path/to/cert/bundle.pem - A filename of the CA cert bundle to uses. You can specify this argument if you want to use a different CA cert bundle than the one used by botocore.
  - `endpoint_url` (string, optional): The complete URL to use for the constructed client. Normally, botocore will automatically construct the appropriate URL to use when communicating with a service. You can specify a complete URL (including the "http/https" scheme) to override this behavior. If this value is provided, then ``use_ssl`` is ignored.
  - `aws_access_key_id` (string, optional): The access key to use when creating the client. This is entirely optional, and if not provided, the credentials configured for the session will automatically be used. You only need to provide this argument if you want to override the credentials used for this specific client.
  - `aws_secret_access_key` (string, optional): The secret key to use when creating the client. Same semantics as aws_access_key_id above.
  - `aws_session_token` (string, optional): The session token to use when creating the client. Same semantics as aws_access_key_id above.
  - `config` (botocore.client.Config, optional): Advanced client configuration options. If region_name is specified in the client config, its value will take precedence over environment variables and configuration values, but not over a region_name value passed explicitly to the method. See `botocore config documentation <https://botocore.amazonaws.com/v1/documentation/api/latest/reference/config.html>`_ for more details.
  - `aws_account_id` (string, optional): The account id to use when creating the client. Same semantics as aws_access_key_id above.
- Returns: Service client instance

**resource()**: Create a resource service client by name.
- Parameters:
  - `service_name` (string): The name of a service, e.g. 's3' or 'ec2'. You can get a list of available services via :py:meth:`get_available_resources`.
  - `region_name` (string, optional): The name of the region associated with the client. A client is associated with a single region.
  - `api_version` (string, optional): The API version to use. By default, botocore will use the latest API version when creating a client. You only need to specify this parameter if you want to use a previous API version of the client.
  - `use_ssl` (boolean, optional): Whether or not to use SSL. By default, SSL is used. Note that not all services support non-ssl connections.
  - `verify` (boolean/string, optional): Whether or not to verify SSL certificates. By default SSL certificates are verified. You can provide the following values: False - do not validate SSL certificates. SSL will still be used (unless use_ssl is False), but SSL certificates will not be verified; path/to/cert/bundle.pem - A filename of the CA cert bundle to uses. You can specify this argument if you want to use a different CA cert bundle than the one used by botocore.
  - `endpoint_url` (string, optional): The complete URL to use for the constructed client. Normally, botocore will automatically construct the appropriate URL to use when communicating with a service. You can specify a complete URL (including the "http/https" scheme) to override this behavior. If this value is provided, then ``use_ssl`` is ignored.
  - `aws_access_key_id` (string, optional): The access key to use when creating the client. This is entirely optional, and if not provided, the credentials configured for the session will automatically be used. You only need to provide this argument if you want to override the credentials used for this specific client.
  - `aws_secret_access_key` (string, optional): The secret key to use when creating the client. Same semantics as aws_access_key_id above.
  - `aws_session_token` (string, optional): The session token to use when creating the client. Same semantics as aws_access_key_id above.
  - `config` (botocore.client.Config, optional): Advanced client configuration options. If region_name is specified in the client config, its value will take precedence over environment variables and configuration values, but not over a region_name value passed explicitly to the method. If user_agent_extra is specified in the client config, it overrides the default user_agent_extra provided by the resource API. See `botocore config documentation <https://botocore.amazonaws.com/v1/documentation/api/latest/reference/config.html>`_ for more details.
- Returns: Subclass of :py:class:`~boto3.resources.base.ServiceResource`

**Internal Methods**:

**_setup_loader()**: Set up loader paths for resource loading
- Returns: None
- Note: Internal method called during initialization

**_register_default_handlers()**: Register default event handlers for the session
- Returns: None
- Note: Internal method called during initialization

**_account_id_set_without_credentials()**: Check if account ID is set without credentials
- Parameters (keyword-only):
  - `aws_account_id`: AWS account ID
  - `aws_access_key_id`: AWS access key ID
  - `aws_secret_access_key`: AWS secret access key
  - `**kwargs`: Additional keyword arguments
- Returns: bool (True if account ID set without credentials, False otherwise)
- Note: Internal validation method

**Usage Example**:
```python
from boto3.session import Session

# Create a session with credentials
session = Session(
    aws_access_key_id='YOUR_ACCESS_KEY',
    aws_secret_access_key='YOUR_SECRET_KEY',
    region_name='us-west-2'
)

# Get credentials
credentials = session.get_credentials()
print(credentials.access_key)

# Get available services
services = session.get_available_services()
print('s3' in services)  # True

# Get available resources
resources = session.get_available_resources()
print('s3' in resources)  # True

# Get available regions
regions = session.get_available_regions('s3')
print('us-west-2' in regions)  # True

# Create clients and resources
s3_client = session.client('s3')
s3_resource = session.resource('s3')
```

#### 3. S3Transfer Class

**Function Description**: High-level abstraction class for S3 file transfer operations.

**Import Method**:
```python
from boto3.s3.transfer import S3Transfer
```

**Class Signature**:
```python
class S3Transfer:
    """S3 file transfer manager"""
    
    ALLOWED_DOWNLOAD_ARGS: list
    ALLOWED_UPLOAD_ARGS: list
    ALLOWED_COPY_ARGS: list
    
    def __init__(self, client=None, config=None, osutil=None, manager=None) -> None
    
    def upload_file(
        self, 
        filename, 
        bucket, 
        key, 
        callback=None, 
        extra_args=None
    ) -> None
    
    def download_file(
        self, 
        bucket, 
        key, 
        filename, 
        extra_args=None, 
        callback=None
    ) -> None
    
    def _get_subscribers(self, callback) -> list | None
    
    def __enter__(self) -> 'S3Transfer'
    
    def __exit__(self, *args) -> None
```

**Parameters** (__init__ parameters):
- `client` (boto3.client, optional): S3 client instance for API calls (default: None)
- `config` (TransferConfig, optional): TransferConfig object for transfer configuration (default: None, uses default TransferConfig)
- `osutil` (s3transfer.utils.OSUtils, optional): OS utility object for file operations (default: None, creates new OSUtils)
- `manager` (s3transfer.manager.TransferManager, optional): Pre-configured transfer manager for handling operations (default: None)

**Note**: Either `client` or `manager` must be provided, but not both. The `manager` parameter is mutually exclusive with `client`, `config`, and `osutil`.

**Class Attributes**:
- `ALLOWED_DOWNLOAD_ARGS` (list): Inherited from TransferManager, allowed extra args for downloads
- `ALLOWED_UPLOAD_ARGS` (list): Inherited from TransferManager, allowed extra args for uploads
- `ALLOWED_COPY_ARGS` (list): Inherited from TransferManager, allowed extra args for copies

**Instance Attributes** (set during initialization):
- `_manager` (s3transfer.manager.TransferManager): The underlying transfer manager handling the actual transfers

**Main Methods**:

**upload_file()**: Upload a file to an S3 object. Variants have also been injected into S3 client, Bucket and Object. You don't have to use S3Transfer.upload_file() directly.
- Parameters:
  - `filename` (str or PathLike): Path to local file to upload
  - `bucket` (str): Name of the S3 bucket
  - `key` (str): S3 object key (destination path)
  - `callback` (callable, optional): Optional callback function for progress tracking
  - `extra_args` (dict, optional): Additional arguments for the upload (e.g., metadata, ACL)
- Returns: None
- See also: :py:meth:`S3.Client.upload_file`, :py:meth:`S3.Client.upload_fileobj`

**download_file()**: Download an S3 object to a file. Variants have also been injected into S3 client, Bucket and Object. You don't have to use S3Transfer.download_file() directly.
- Parameters:
  - `bucket` (str): Name of the S3 bucket
  - `key` (str): S3 object key (source path)
  - `filename` (str or PathLike): Path to local file to save download
  - `extra_args` (dict, optional): Additional arguments for the download
  - `callback` (callable, optional): Optional callback function for progress tracking
- Returns: None
- See also: :py:meth:`S3.Client.download_file`, :py:meth:`S3.Client.download_fileobj`

**Internal Methods**:

**_get_subscribers()**: Convert callback function to list of subscribers
- Parameters:
  - `callback`: Progress callback function
- Returns: List of ProgressCallbackInvoker subscribers or None
- Note: Internal method for handling progress callbacks

**Usage Example**:
```python
from boto3.s3.transfer import S3Transfer
import boto3

# Create S3 client and transfer manager
s3_client = boto3.client('s3', region_name='us-west-2')
transfer = S3Transfer(s3_client)

# Upload a file
transfer.upload_file('local_file.txt', 'my-bucket', 'remote_file.txt')

# Download a file
transfer.download_file('my-bucket', 'remote_file.txt', 'downloaded_file.txt')

# Upload with callback
def progress_callback(bytes_transferred):
    print(f"Transferred: {bytes_transferred} bytes")

transfer.upload_file(
    'local_file.txt', 
    'my-bucket', 
    'remote_file.txt',
    callback=progress_callback
)
```

#### 4. TransferConfig Class

**Function Description**: Configuration class for S3 transfer parameters including multipart thresholds, concurrency, and bandwidth settings.

**Import Method**:
```python
from boto3.s3.transfer import TransferConfig
```

**Parent Class**: `S3TransferConfig` from `s3transfer.manager`

**Note**: This class extends `S3TransferConfig` from the `s3transfer` dependency library, adding boto3-specific configuration options.

**Class Signature**:
```python
class TransferConfig(S3TransferConfig):
    """S3 transfer configuration"""
    
    ALIAS: dict = {
        'max_concurrency': 'max_request_concurrency',
        'max_io_queue': 'max_io_queue_size',
    }
    
    multipart_threshold: int
    max_concurrency: int
    multipart_chunksize: int
    num_download_attempts: int
    max_io_queue: int
    io_chunksize: int
    use_threads: bool
    max_bandwidth: int
    preferred_transfer_client: str
    
    def __init__(
        self,
        multipart_threshold=8 * MB,
        max_concurrency=10,
        multipart_chunksize=8 * MB,
        num_download_attempts=5,
        max_io_queue=100,
        io_chunksize=256 * KB,
        use_threads=True,
        max_bandwidth=None,
        preferred_transfer_client=constants.AUTO_RESOLVE_TRANSFER_CLIENT,
    ) -> None
    
    def __setattr__(self, name: str, value) -> None
```

**Parameters** (__init__ parameters):
- `multipart_threshold` (int): The transfer size threshold for which multipart uploads, downloads, and copies will automatically be triggered. (default: 8MB)
- `max_concurrency` (int): The maximum number of threads that will be making requests to perform a transfer. If ``use_threads`` is set to ``False``, the value provided is ignored as the transfer will only ever use the current thread. (default: 10)
- `multipart_chunksize` (int): The partition size of each part for a multipart transfer. (default: 8MB)
- `num_download_attempts` (int): The number of download attempts that will be retried upon errors with downloading an object in S3. Note that these retries account for errors that occur when streaming down the data from s3 (i.e. socket errors and read timeouts that occur after receiving an OK response from s3). Other retryable exceptions such as throttling errors and 5xx errors are already retried by botocore (this default is 5). This does not take into account the number of exceptions retried by botocore. (default: 5)
- `max_io_queue` (int): The maximum amount of read parts that can be queued in memory to be written for a download. The size of each of these read parts is at most the size of ``io_chunksize``. (default: 100)
- `io_chunksize` (int): The max size of each chunk in the io queue. Currently, this is size used when ``read`` is called on the downloaded stream as well. (default: 256KB)
- `use_threads` (bool): If True, threads will be used when performing S3 transfers. If False, no threads will be used in performing transfers; all logic will be run in the current thread. (default: True)
- `max_bandwidth` (int): The maximum bandwidth that will be consumed in uploading and downloading file content. The value is an integer in terms of bytes per second. (default: None)
- `preferred_transfer_client` (str): String specifying preferred transfer client for transfer operations. Current supported settings are: auto (default) - Use the CRTTransferManager when calls are made with supported environment and settings; classic - Only use the origin S3TransferManager with requests. Disables possible CRT upgrade on requests. (default: 'auto')

**Class Attributes**:
- `ALIAS` (dict): Dictionary mapping boto3 parameter names to s3transfer names
  - `'max_concurrency'` → `'max_request_concurrency'`
  - `'max_io_queue'` → `'max_io_queue_size'`

**Instance Attributes** (set after initialization):
- `multipart_threshold` (int): Inherited from S3TransferConfig
- `max_request_concurrency` (int): Inherited from S3TransferConfig (also accessible as `max_concurrency` via ALIAS)
- `multipart_chunksize` (int): Inherited from S3TransferConfig
- `num_download_attempts` (int): Inherited from S3TransferConfig
- `max_io_queue_size` (int): Inherited from S3TransferConfig (also accessible as `max_io_queue` via ALIAS)
- `io_chunksize` (int): Inherited from S3TransferConfig
- `max_bandwidth` (int): Inherited from S3TransferConfig
- `use_threads` (bool): Whether threading is enabled for transfers
- `preferred_transfer_client` (str): Transfer client preference (boto3-specific)

**Usage Example**:
```python
from boto3.s3.transfer import S3Transfer, TransferConfig
import boto3

# Create transfer configuration
config = TransferConfig(
    multipart_threshold=1024 * 25,  # 25MB
    max_concurrency=10,
    multipart_chunksize=1024 * 25,  # 25MB
    use_threads=True
)

# High-performance configuration
high_performance_config = TransferConfig(
    multipart_threshold=1 * 1024 * 1024,  # 1MB
    max_concurrency=20,
    multipart_chunksize=16 * 1024 * 1024,  # 16MB
    max_bandwidth=100 * 1024 * 1024  # 100MB/s
)

# Create transfer manager with config
s3_client = boto3.client('s3')
transfer = S3Transfer(s3_client, config)
transfer.upload_file('local_file.txt', 'my-bucket', 'remote_file.txt')
```

#### 5. Attr Class

**Function Description**: Builder class for DynamoDB attribute condition expressions used in FilterExpression.

**Import Method**:
```python
from boto3.dynamodb.conditions import Attr
```

**Parent Class**: `AttributeBase` from `boto3.dynamodb.conditions`

**Class Signature**:
```python
class Attr(AttributeBase):
    """Represents an DynamoDB item's attribute."""
    
    def ne(self, value):
        """Creates a condition where the attribute is not equal to the value
        
        :param value: The value that the attribute is not equal to.
        """
        return NotEquals(self, value)
    
    def is_in(self, value):
        """Creates a condition where the attribute is in the value,
        
        :type value: list
        :param value: The value that the attribute is in.
        """
        return In(self, value)
    
    def exists(self):
        """Creates a condition where the attribute exists."""
        return AttributeExists(self)
    
    def not_exists(self):
        """Creates a condition where the attribute does not exist."""
        return AttributeNotExists(self)
    
    def contains(self, value):
        """Creates a condition where the attribute contains the value.
        
        :param value: The value the attribute contains.
        """
        return Contains(self, value)
    
    def size(self):
        """Creates a condition for the attribute size.
        
        Note another AttributeBase method must be called on the returned
        size condition to be a valid DynamoDB condition.
        """
        return Size(self)
    
    def attribute_type(self, value):
        """Creates a condition for the attribute type.
        
        :param value: The type of the attribute.
        """
        return AttributeType(self, value)
```

**Parameters** (__init__ parameters):
- `name` (str): Name of the DynamoDB attribute to build conditions for

**Instance Attributes** (inherited from AttributeBase):
- `name` (str): Stored attribute name

**Main Methods**:

**ne()**: Creates a condition where the attribute is not equal to the value
- Parameters:
  - `value`: The value that the attribute is not equal to.
- Returns: NotEquals - A condition object representing the not-equals comparison

**is_in()**: Creates a condition where the attribute is in the value,
- Parameters:
  - `value` (list): The value that the attribute is in.
- Returns: In - A condition object representing the in comparison

**exists()**: Creates a condition where the attribute exists.
- Parameters: None
- Returns: AttributeExists - A condition object representing the attribute exists check

**not_exists()**: Creates a condition where the attribute does not exist.
- Parameters: None
- Returns: AttributeNotExists - A condition object representing the attribute not exists check

**contains()**: Creates a condition where the attribute contains the value.
- Parameters:
  - `value`: The value the attribute contains.
- Returns: Contains - A condition object representing the contains comparison

**size()**: Creates a condition for the attribute size.
- Parameters: None
- Returns: Size - A condition object representing the size function
- Note: Another AttributeBase method must be called on the returned size condition to be a valid DynamoDB condition.

**attribute_type()**: Creates a condition for the attribute type.
- Parameters:
  - `value`: The type of the attribute.
- Returns: AttributeType - A condition object representing the attribute type check

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')

# Simple conditions
response = table.scan(FilterExpression=Attr('age').gte(25))

# Complex conditions
response = table.scan(
    FilterExpression=Attr('age').gte(25) & Attr('city').eq('New York')
)

# Range condition
response = table.scan(FilterExpression=Attr('age').between(20, 30))

# String operations
response = table.scan(FilterExpression=Attr('name').begins_with('John'))
response = table.scan(FilterExpression=Attr('description').contains('Python'))

# Existence checks
response = table.scan(FilterExpression=Attr('email').exists())
response = table.scan(FilterExpression=Attr('deleted_at').not_exists())

# Combining conditions
complex_filter = (
    Attr('age').gt(20) & 
    Attr('age').lt(30) & 
    (Attr('city').eq('New York') | Attr('city').eq('Los Angeles'))
)
response = table.scan(FilterExpression=complex_filter)
```

#### 6. Key Class

**Function Description**: Builder class for DynamoDB key condition expressions used in KeyConditionExpression for Query operations.

**Import Method**:
```python
from boto3.dynamodb.conditions import Key
```

**Parent Class**: `AttributeBase` from `boto3.dynamodb.conditions`

**Class Signature**:
```python
class Key(AttributeBase):
    pass
```

**Parameters** (__init__ parameters - inherited from AttributeBase):
- `name` (str): Name of the DynamoDB key attribute for building key conditions

**Instance Attributes** (inherited from AttributeBase):
- `name` (str): Stored key attribute name

**Note**: The Key class inherits all methods from `AttributeBase`, including `eq()`, `lt()`, `lte()`, `gt()`, `gte()`, `between()`, and `begins_with()`. See AttributeBase documentation for method details.

**Usage Example**:
```python
from boto3.dynamodb.conditions import Key, Attr
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')

# Query with partition key only
response = table.query(
    KeyConditionExpression=Key('user_id').eq('12345')
)

# Query with partition key and sort key
response = table.query(
    KeyConditionExpression=Key('user_id').eq('12345') & Key('timestamp').between('2023-01-01', '2023-12-31')
)

# Query with sort key range
response = table.query(
    KeyConditionExpression=Key('user_id').eq('12345') & Key('timestamp').gte('2023-01-01')
)

# Query with begins_with on sort key
response = table.query(
    KeyConditionExpression=Key('user_id').eq('12345') & Key('timestamp').begins_with('2023')
)

# Combine KeyConditionExpression with FilterExpression
response = table.query(
    KeyConditionExpression=Key('user_id').eq('12345'),
    FilterExpression=Attr('age').gte(25) & Attr('status').eq('active')
)
```

#### 7. create_tags() Function

**Function Description**: Create tags for EC2 resources in batch operations.

**Import Method**:
```python
from boto3.ec2 import createtags
# Or use through EC2 resource
ec2 = boto3.resource('ec2')
instance = ec2.Instance('instance-id')
instance.create_tags(**kwargs)
```

**Function Signature**:
```python
def create_tags(self, **kwargs) -> list
```

**Parameters**:
- `Resources` (list): List of EC2 resource IDs to be tagged (e.g., instance IDs, volume IDs)
- `Tags` (list): List of tag dictionaries, each containing 'Key' and 'Value' fields

**Return Value**:
- Returns list of created Tag resource objects

**Usage Example**:
```python
import boto3

ec2 = boto3.resource('ec2', region_name='us-west-2')

# Tag a single instance
instance = ec2.Instance('i-1234567890abcdef0')
tag_resources = instance.create_tags(
    Tags=[
        {'Key': 'Environment', 'Value': 'Production'},
        {'Key': 'Project', 'Value': 'WebApp'},
        {'Key': 'Owner', 'Value': 'DevOps'}
    ]
)

# Tag multiple resources
instances = ec2.instances.filter(InstanceIds=['i-1234567890abcdef0', 'i-0987654321fedcba0'])
for instance in instances:
    instance.create_tags(
        Tags=[
            {'Key': 'Department', 'Value': 'Engineering'},
            {'Key': 'CostCenter', 'Value': 'CC-1234'}
        ]
    )
```

#### 8. delete_tags() Function

**Function Description**: Delete tags from EC2 resources in batch operations.

**Import Method**:
```python
from boto3.ec2.deletetags import delete_tags
# Or use through EC2 resource
ec2 = boto3.resource('ec2')
instance = ec2.Instance('instance-id')
instance.delete_tags(**kwargs)
```

**Function Signature**:
```python
def delete_tags(self, **kwargs) -> dict
```

**Parameters**:
- `Resources` (list): List of EC2 resource IDs from which tags will be deleted
- `Tags` (list): List of tag dictionaries to delete. Can include only 'Key' to delete all values for that key, or both 'Key' and 'Value' for specific tag deletion

**Return Value**:
- Returns dict - API response from the delete_tags client operation

**Usage Example**:
```python
import boto3

ec2 = boto3.resource('ec2', region_name='us-west-2')

# Delete specific tags from an instance
instance = ec2.Instance('i-1234567890abcdef0')
instance.delete_tags(
    Tags=[
        {'Key': 'Environment'},  # Delete all Environment tags
        {'Key': 'Project', 'Value': 'WebApp'}  # Delete specific tag
    ]
)

# Delete tags from multiple resources
instances = ec2.instances.filter(
    Filters=[{'Name': 'tag:Temporary', 'Values': ['true']}]
)
for instance in instances:
    instance.delete_tags(Tags=[{'Key': 'Temporary'}])
```

#### 9. CRTTransferManager Class

**Function Description**: High-performance transfer manager based on AWS Common Runtime (CRT) for optimized S3 transfers.

**Import Method** (External library import path):
```python
# This class is from s3transfer.crt (external third-party dependency library)
from s3transfer.crt import CRTTransferManager
```

**Note**: This class is **imported from the external third-party library `s3transfer.crt`**, not implemented in boto3 directly. The import path above is from the external library, not boto3's internal path. 

**Recommended Usage**: Use `create_crt_transfer_manager()` function to obtain an instance instead of instantiating directly.

```python
from boto3.crt import create_crt_transfer_manager
```

**Usage Example**:
```python
from boto3.crt import create_crt_transfer_manager
from boto3.s3.transfer import TransferConfig
import boto3

s3_client = boto3.client('s3', region_name='us-west-2')

# Create CRT transfer configuration
config = TransferConfig(
    preferred_transfer_client="crt",
    max_concurrency=10,
    multipart_threshold=8 * 1024 * 1024  # 8MB
)

# Create CRT transfer manager (returns None if CRT not available)
transfer_manager = create_crt_transfer_manager(s3_client, config)

if transfer_manager:
    # Use for high-performance uploads
    future = transfer_manager.upload('local_file.txt', 'my-bucket', 'remote_file.txt')
    future.result()  # Wait for completion
    
    # Use for high-performance downloads
    future = transfer_manager.download('my-bucket', 'remote_file.txt', 'downloaded_file.txt')
    future.result()  # Wait for completion
```

#### 10. setup_default_session() Function

**Function Description**: Set the default boto3 session with specified credentials and configuration.

**Import Method**:
```python
import boto3
```

**Function Signature**:
```python
def setup_default_session(**kwargs) -> None
```

**Parameters**:
- `**kwargs`: Same parameters accepted by Session() constructor (aws_access_key_id, aws_secret_access_key, region_name, etc.)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

# Setup default session
boto3.setup_default_session(
    aws_access_key_id='YOUR_ACCESS_KEY',
    aws_secret_access_key='YOUR_SECRET_KEY',
    region_name='us-west-2'
)

# Now all clients and resources will use this session by default
s3 = boto3.client('s3')  # Uses the default session
dynamodb = boto3.resource('dynamodb')  # Uses the default session
```

#### 11. set_stream_logger() Function

**Function Description**: Add a stream handler to the logging module for boto3 logging output.

**Import Method**:
```python
import boto3
```

**Function Signature**:
```python
def set_stream_logger(name='boto3', level=logging.DEBUG, format_string=None) -> None
```

**Parameters**:
- `name` (str): Logger name, default is 'boto3'
- `level` (int): Logging level (e.g., logging.DEBUG, logging.INFO)
- `format_string` (str): Custom format string for log messages

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3
import logging

# Enable debug logging
boto3.set_stream_logger('boto3', level=logging.DEBUG)

# Enable info logging with custom format
boto3.set_stream_logger(
    'boto3',
    level=logging.INFO,
    format_string='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Now all boto3 operations will log to console
s3 = boto3.client('s3')
s3.list_buckets()  # This will show debug output
```

#### 12. Binary Class

**Function Description**: Wrapper class for binary data in DynamoDB operations.

**Import Method**:
```python
from boto3.dynamodb.types import Binary
```

**Class Signature**:
```python
class Binary:
    """DynamoDB binary data wrapper"""
    
    value: bytes
    
    def __init__(self, value: bytes) -> None
    
    def __eq__(self, other) -> bool
    
    def __ne__(self, other) -> bool
    
    def __repr__(self) -> str
    
    def __str__(self) -> str
    
    def __bytes__(self) -> bytes
    
    def __hash__(self) -> int
```

**Parameters** (__init__ parameters):
- `value` (bytes or bytearray): Binary data to be stored in DynamoDB (must be bytes or bytearray type)

**Instance Attributes** (set during initialization):
- `value` (bytes or bytearray): The underlying binary object

**Main Methods**:

**__eq__()**: Check equality with another Binary object
- Parameters:
  - `other`: Another object to compare
- Returns: bool (True if equal)

**__ne__()**: Check inequality with another Binary object
- Parameters:
  - `other`: Another object to compare
- Returns: bool (True if not equal)

**__repr__()**: Return string representation for debugging
- Returns: str (representation string)

**__str__()**: Return string representation
- Returns: str (string representation)

**__bytes__()**: Return the underlying bytes object
- Returns: bytes (the binary data)

**__hash__()**: Return hash value for the Binary object
- Returns: int (hash value)

**Usage Example**:
```python
from boto3.dynamodb.types import Binary
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')

# Store binary data
binary_data = Binary(b'\x00\x01\x02\x03')
table.put_item(Item={
    'id': '123',
    'data': binary_data,
    'image': Binary(open('image.png', 'rb').read())
})

# Retrieve binary data
response = table.get_item(Key={'id': '123'})
retrieved_data = response['Item']['data']
print(type(retrieved_data))  # <class 'bytes'>
```

#### 13. BatchWriter Class

**Function Description**: Context manager for efficient batch write operations to DynamoDB tables.

**Import Method**:
```python
from boto3.dynamodb.table import BatchWriter
# Or use through table resource
table.batch_writer()
```

**Class Signature**:
```python
class BatchWriter:
    """Automatically handle batch writes to DynamoDB for a single table."""
    
    def __init__(
        self, 
        table_name, 
        client, 
        flush_amount=25, 
        overwrite_by_pkeys=None
    )
    
    def put_item(self, Item)
    
    def delete_item(self, Key)
    
    def _add_request_and_process(self, request)
    
    def _remove_dup_pkeys_request_if_any(self, request)
    
    def _extract_pkey_values(self, request)
    
    def _flush_if_needed(self)
    
    def _flush(self)
    
    def __enter__(self)
    
    def __exit__(self, exc_type, exc_value, tb)
```

**Parameters** (__init__ parameters):
- `table_name` (str): The name of the table. The class handles batch writes to a single table.
- `client` (botocore.client.Client): A botocore client. Note this client **must** have the dynamodb customizations applied to it for transforming AttributeValues into the wire protocol. What this means in practice is that you need to use a client that comes from a DynamoDB resource if you're going to instantiate this class directly, i.e ``boto3.resource('dynamodb').Table('foo').meta.client``.
- `flush_amount` (int): The number of items to keep in a local buffer before sending a batch_write_item request to DynamoDB. (default: 25)
- `overwrite_by_pkeys` (list(string)): De-duplicate request items in buffer if match new request item on specified primary keys. i.e ``["partition_key1", "sort_key2", "sort_key3"]`` (default: None)

**Instance Attributes** (set during initialization):
- `_table_name` (str): Stored table name
- `_client` (botocore.client.Client): Stored client reference
- `_items_buffer` (list): Buffer for accumulating write requests
- `_flush_amount` (int): Threshold for auto-flushing
- `_overwrite_by_pkeys` (list): Primary key names for de-duplication

**Main Methods**:

**put_item()**: Add a put item request to the batch
- Parameters:
  - `Item` (dict): The item to put to DynamoDB
- Returns: None

**delete_item()**: Add a delete item request to the batch
- Parameters:
  - `Key` (dict): The key of the item to delete from DynamoDB
- Returns: None

**Internal Methods**:

**_add_request_and_process()**: Add a request to buffer and process if needed
- Parameters:
  - `request`: Request dictionary to add
- Returns: None
- Note: Internal method for managing request buffer

**_remove_dup_pkeys_request_if_any()**: Remove duplicate requests based on primary keys
- Parameters:
  - `request`: Request to check for duplicates
- Returns: None
- Note: Internal deduplication logic

**_extract_pkey_values()**: Extract primary key values from a request
- Parameters:
  - `request`: Request dictionary
- Returns: list - List of primary key values, or None if request has no PutRequest or DeleteRequest
- Note: Internal helper for deduplication

**_flush_if_needed()**: Check buffer size and flush if threshold reached
- Returns: None
- Note: Internal method called after each add operation

**_flush()**: Send all buffered items to DynamoDB
- Returns: None
- Note: Internal method that performs actual batch write API call

**Usage Example**:
```python
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')

# Batch write operations
with table.batch_writer() as batch:
    for i in range(100):
        batch.put_item(Item={
            'id': str(i),
            'data': f'value_{i}'
        })
    
    # Also delete items in same batch
    batch.delete_item(Key={'id': '999'})

# With overwrite protection
with table.batch_writer(overwrite_by_pkeys=['id']) as batch:
    batch.put_item(Item={'id': '1', 'name': 'Alice'})
    batch.put_item(Item={'id': '2', 'name': 'Bob'})
```

#### 14. CRTS3Client Class

**Function Description**: Internal CRT S3 client wrapper for high-performance transfers.

**Import Method**:
```python
from boto3.crt import CRTS3Client
```

**Class Signature**:
```python
class CRTS3Client:
    """
    This wrapper keeps track of our underlying CRT client, the lock used to
    acquire it and the region we've used to instantiate the client.

    Due to limitations in the existing CRT interfaces, we can only make calls
    in a single region and does not support redirects. We track the region to
    ensure we don't use the CRT client when a successful request cannot be made.
    """
    
    def __init__(self, crt_client, process_lock, region, cred_provider) -> None
```

**Parameters** (__init__ parameters):
- `crt_client` (awscrt.s3.S3Client): AWS CRT S3 client instance
- `process_lock` (threading.Lock): Process lock for thread-safe operations
- `region` (str): AWS region name
- `cred_provider` (awscrt.auth.AwsCredentialsProvider): CRT credentials provider

**Instance Attributes** (set during initialization):
- `crt_client` (awscrt.s3.S3Client): The underlying CRT S3 client
- `process_lock` (threading.Lock): Lock object for synchronization
- `region` (str): AWS region
- `cred_provider` (awscrt.auth.AwsCredentialsProvider): Credentials provider

**Usage Example**:
```python
# This is an internal class used by boto3's CRT transfer manager
# Typically not instantiated directly by users
from boto3.crt import get_crt_s3_client
import boto3

s3_client = boto3.client('s3')
crt_client = get_crt_s3_client(s3_client, config)
```

#### 15. ServiceContext Class

**Function Description**: Named tuple storing service context information including service name, models, and resource definitions.

**Import Method**:
```python
from boto3.utils import ServiceContext
```

**Parent Class**: `_ServiceContext` (named tuple)

**Class Signature**:
```python
class ServiceContext(_ServiceContext):
    """Provides important service-wide, read-only information about a service

    :type service_name: str
    :param service_name: The name of the service

    :type service_model: :py:class:`botocore.model.ServiceModel`
    :param service_model: The model of the service.

    :type service_waiter_model: :py:class:`botocore.waiter.WaiterModel` or
        a waiter model-like object such as
        :py:class:`boto3.utils.LazyLoadedWaiterModel`
    :param service_waiter_model: The waiter model of the service.

    :type resource_json_definitions: dict
    :param resource_json_definitions: The loaded json models of all resource
        shapes for a service. It is equivalient of loading a
        ``resource-1.json`` and retrieving the value at the key "resources".
    """

    pass
```

**Note**: This is a named tuple subclass. The following are both constructor parameters and accessible attributes.

**Usage Example**:
```python
from boto3.utils import ServiceContext
from boto3.session import Session

session = Session()
# ServiceContext is typically created internally
# It contains metadata about the service being used
```

#### 16. LazyLoadedWaiterModel Class

**Function Description**: Lazy-loading wrapper for service waiter models to defer loading until actually needed.

**Import Method**:
```python
from boto3.utils import LazyLoadedWaiterModel
```

**Class Signature**:
```python
class LazyLoadedWaiterModel:
    """A lazily loaded waiter model
    
    This does not load the service waiter model until an attempt is made
    to retrieve the waiter model for a specific waiter. This is helpful
    in docstring generation where we do not need to actually need to grab
    the waiter-2.json until it is accessed through a ``get_waiter`` call
    when the docstring is generated/accessed.
    """
    
    def __init__(self, bc_session, service_name, api_version) -> None
    
    def get_waiter(self, waiter_name) -> botocore.waiter.WaiterModel
```

**Parameters** (__init__ parameters):
- `bc_session`: Botocore session instance
- `service_name`: Name of the AWS service
- `api_version`: API version of the service

**Instance Attributes** (set during initialization):
- `_session` (botocore.session.Session): Stored botocore session reference
- `_service_name` (str): Stored service name
- `_api_version` (str): Stored API version

**Main Methods**:

**get_waiter()**: Retrieve the waiter model for a specific waiter (lazy loads waiter model on first call)
- Parameters:
  - `waiter_name` (str): Name of the waiter
- Returns: botocore.waiter.WaiterModel - The waiter model for the specified waiter

**Usage Example**:
```python
# This is typically used internally by boto3
from boto3.utils import LazyLoadedWaiterModel
import botocore.session

bc_session = botocore.session.get_session()
waiter_model = LazyLoadedWaiterModel(bc_session, 's3', '2006-03-01')
specific_waiter = waiter_model.get_waiter('bucket_exists')
```

#### 17. Boto3Error Class

**Function Description**: Base exception class for all boto3-specific errors.

**Import Method**:
```python
from boto3.exceptions import Boto3Error
```

**Parent Class**: `Exception`

**Class Signature**:
```python
class Boto3Error(Exception):
    """Base class for boto3 exceptions"""
    
```

**Usage Example**:
```python
from boto3.exceptions import Boto3Error

try:
    # Some boto3 operation
    pass
except Boto3Error as e:
    print(f"Boto3 error occurred: {e}")
```

#### 18. NoVersionFound Class

**Function Description**: Exception raised when no valid API version can be found for a service.

**Import Method**:
```python
from boto3.exceptions import NoVersionFound
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class NoVersionFound(Boto3Error):
    pass
```

**Usage Example**:
```python
from boto3.exceptions import NoVersionFound
import boto3

try:
    # Attempt to create resource with invalid API version
    s3 = boto3.resource('s3', api_version='invalid')
except NoVersionFound as e:
    print(f"API version not found: {e}")
```

#### 19. RetriesExceededError Class

**Function Description**: Exception raised when retry attempts are exceeded for an operation.

**Import Method**:
```python
from boto3.exceptions import RetriesExceededError
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class RetriesExceededError(Boto3Error):
    """Retries exceeded exception"""
    
    def __init__(self, last_exception, msg: str = '') -> None
```

**Parameters** (__init__ parameters):
- `last_exception` (Exception): The last exception that occurred before retries were exhausted
- `msg` (str, optional): Optional custom error message (default: '')

**Instance Attributes** (set during initialization):
- `last_exception` (Exception): The final exception encountered
- `msg` (str): Error message describing the retry failure

**Usage Example**:
```python
from boto3.exceptions import RetriesExceededError

try:
    # Operation with retries
    pass
except RetriesExceededError as e:
    print(f"Max retries exceeded: {e}")
    print(f"Last exception: {e.last_exception}")
```

#### 20. S3TransferFailedError Class

**Function Description**: Exception raised when an S3 transfer operation fails.

**Import Method**:
```python
from boto3.exceptions import S3TransferFailedError
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class S3TransferFailedError(Boto3Error):
    pass
```

**Usage Example**:
```python
from boto3.exceptions import S3TransferFailedError
import boto3

s3 = boto3.client('s3')
try:
    s3.upload_file('file.txt', 'bucket', 'key')
except S3TransferFailedError as e:
    print(f"S3 transfer failed: {e}")
```

#### 21. S3UploadFailedError Class

**Function Description**: Exception raised when an S3 upload specifically fails.

**Import Method**:
```python
from boto3.exceptions import S3UploadFailedError
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class S3UploadFailedError(Boto3Error):
    pass
```

**Usage Example**:
```python
from boto3.exceptions import S3UploadFailedError
from boto3.s3.transfer import S3Transfer
import boto3

s3_client = boto3.client('s3')
transfer = S3Transfer(s3_client)

try:
    transfer.upload_file('local.txt', 'my-bucket', 'remote.txt')
except S3UploadFailedError as e:
    print(f"Upload failed: {e}")
```

#### 22. PythonDeprecationWarning Class

**Function Description**: Warning class for Python version deprecation notices.

**Import Method**:
```python
from boto3.exceptions import PythonDeprecationWarning
```

**Parent Class**: `Warning`

**Class Signature**:
```python
class PythonDeprecationWarning(Warning):
    """
    Python version being used is scheduled to become unsupported
    in an future release. See warning for specifics.
    """

    pass
```

**Usage Example**:
```python
import warnings
from boto3.exceptions import PythonDeprecationWarning

# This warning is raised internally when using deprecated Python versions
warnings.filterwarnings('ignore', category=PythonDeprecationWarning)
```

#### 23. ProgressCallbackInvoker Class

**Function Description**: A back-compat wrapper to invoke a provided callback via a subscriber.

**Import Method**:
```python
# This class is defined in boto3/s3/transfer.py
from boto3.s3.transfer import ProgressCallbackInvoker
```

**Parent Class**: `BaseSubscriber` from `s3transfer.subscribers`

**Note**: This class extends `BaseSubscriber` from the `s3transfer` dependency library.

**Class Signature**:
```python
class ProgressCallbackInvoker(BaseSubscriber):
    """A back-compat wrapper to invoke a provided callback via a subscriber
    
    :param callback: A callable that takes a single positional argument for
        how many bytes were transferred.
    """
    
    def __init__(self, callback) -> None
    
    def on_progress(self, bytes_transferred, **kwargs) -> None
```

**Parameters** (__init__ parameters):
- `callback` (callable): A callable that takes a single positional argument for how many bytes were transferred.

**Instance Attributes** (set during initialization):
- `_callback` (callable): Stored callback function reference

**Main Methods**:

**on_progress()**: Called when transfer progress is made
- Parameters:
  - `bytes_transferred` (int): Number of bytes transferred
  - `**kwargs`: Additional keyword arguments (ignored)
- Returns: None

**Usage Example**:
```python
from boto3.s3.transfer import S3Transfer, ProgressCallbackInvoker
import boto3

def progress_callback(bytes_amount):
    print(f"Transferred: {bytes_amount} bytes")

s3_client = boto3.client('s3')
transfer = S3Transfer(s3_client)

# The ProgressCallbackInvoker is used internally when you pass a callback
transfer.upload_file(
    'file.txt',
    'bucket',
    'key',
    callback=progress_callback
)
```

#### 24. CustomModeledAction Class

**Function Description**: Custom action class that allows injecting user-defined actions into resource models.

**Import Method**:
```python
from boto3.resources.action import CustomModeledAction
```

**Class Signature**:
```python
class CustomModeledAction:
    """A custom, modeled action to inject into a resource."""
    
    def __init__(
        self, 
        action_name, 
        action_model, 
        function, 
        event_emitter
    ) -> None
    
    def inject(self, class_attributes, service_context, event_name, **kwargs) -> None
```

**Parameters** (__init__ parameters):
- `action_name` (str): The name of the action to inject, e.g. 'delete_tags'
- `action_model` (dict): A JSON definition of the action, as if it were part of the resource model.
- `function` (function): The function to perform when the action is called. The first argument should be 'self', which will be the resource the function is to be called on.
- `event_emitter` (botocore.hooks.BaseEventHooks): The session event emitter.

**Instance Attributes** (set during initialization):
- `name` (str): Stored action name
- `model` (dict): Stored action model
- `function` (function): Stored implementing function
- `emitter` (botocore.hooks.BaseEventHooks): Stored event emitter

**Main Methods**:

**inject()**: Inject the custom action into a resource class
- Parameters:
  - `class_attributes` (dict): Class attributes dictionary to inject the action into
  - `service_context` (ServiceContext): Service context containing service model and other metadata
  - `event_name` (str): Event name used to extract resource name
  - `**kwargs`: Additional keyword arguments (unused)
- Returns: None
- Note: This method creates an Action object from the model, sets the function name and docstring, then injects it into the class attributes

**Usage Example**:
```python
# This is typically used internally for custom resource actions
from boto3.resources.action import CustomModeledAction

def custom_action_impl(self, **kwargs):
    # Custom implementation
    pass

action = CustomModeledAction(
    'my_custom_action',
    action_model,
    custom_action_impl,
    event_emitter
)
```

#### 25. Identifier Class

**Function Description**: Represents a resource identifier in the resource model.

**Import Method**:
```python
from boto3.resources.model import Identifier
```

**Class Signature**:
```python
class Identifier:
    """
    A resource identifier, given by its name.

    :type name: string
    :param name: The name of the identifier
    """
    def __init__(self, name, member_name=None) -> None
```

**Parameters** (__init__ parameters):
- `name` (string): The name of the identifier
- `member_name` (optional): Optional member name in the service response (default: None)

**Instance Attributes** (set during initialization):
- `name` (string): The name of the identifier
- `member_name`: Member name in the service response (defaults to `name` if not provided)

**Usage Example**:
```python
from boto3.resources.model import Identifier

# Identifiers are typically defined in resource models
bucket_name_id = Identifier('bucket_name', 'BucketName')
instance_id = Identifier('id', 'InstanceId')
```

#### 26. DefinitionWithParams Class

**Function Description**: Base class for resource definitions that include parameters.

**Import Method**:
```python
from boto3.resources.model import DefinitionWithParams
```

**Class Signature**:
```python
class DefinitionWithParams:
    """
    An item which has parameters exposed via the ``params`` property.
    A request has an operation and parameters, while a waiter has
    a name, a low-level waiter name and parameters.

    :type definition: dict
    :param definition: The JSON definition
    """
    
    def __init__(self, definition) -> None
    
    @property
    def params(self) -> list
```

**Parameters** (__init__ parameters):
- `definition` (dict): The JSON definition

**Instance Attributes** (set during initialization):
- `_definition` (dict): Stored definition dictionary

**Properties**:

**params**: Get a list of auto-filled parameters for this request.
- Returns: list(:py:class:`Parameter`) - List of Parameter objects

**Usage Example**:
```python
from boto3.resources.model import DefinitionWithParams

definition = {
    'request': {
        'operation': 'DescribeInstances',
        'params': [
            {'target': 'InstanceIds[0]', 'source': 'identifier', 'name': 'Id'}
        ]
    }
}
obj = DefinitionWithParams(definition)
print(obj.params)  # List of parameters
```

#### 27. ConditionAttributeBase Class

**Function Description**: Base class combining condition and attribute functionality for DynamoDB expressions.

**Import Method**:
```python
from boto3.dynamodb.conditions import ConditionAttributeBase
```

**Parent Class**: `ConditionBase`, `AttributeBase`

**Class Signature**:
```python
class ConditionAttributeBase(ConditionBase, AttributeBase):
    """This base class is for conditions that can have attribute methods.
    
    One example is the Size condition. To complete a condition, you need
    to apply another AttributeBase method like eq().
    """
    
    def __init__(self, *values) -> None
    
    def __eq__(self, other) -> bool
    
    def __ne__(self, other) -> bool
```

**Parameters** (__init__ parameters):
- `*values`: Variable number of values for the condition. The first value is assumed to be the attribute which can be used to generate its attribute base.

**Main Methods**:

**__eq__()**: Check equality between two ConditionAttributeBase instances
- Parameters:
  - `other`: Another object to compare with
- Returns: bool - True if both ConditionBase and AttributeBase parts are equal
- Note: This is the Python equality operator (==)

**__ne__()**: Check inequality between two ConditionAttributeBase instances  
- Parameters:
  - `other`: Another object to compare with
- Returns: bool - True if not equal
- Note: This is the Python inequality operator (!=)

**Usage Example**:
```python
# This is a base class used internally
# Size class inherits from this to provide both condition and attribute features
from boto3.dynamodb.conditions import Attr

# Using Size which inherits from ConditionAttributeBase
attr_size = Attr('data').size()
condition = attr_size.gt(100)  # Size greater than 100
```

#### 28. ComparisonCondition Class

**Function Description**: Base class for all comparison-type conditions in DynamoDB.

**Import Method**:
```python
from boto3.dynamodb.conditions import ComparisonCondition
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class ComparisonCondition(ConditionBase):
    expression_format = '{0} {operator} {1}'
```

**Class Attributes**:
- `expression_format` (str): Format string for comparison expressions. '{0}' is the left operand, '{operator}' is the comparison operator, and '{1}' is the right operand.

**Usage Example**:
```python
# This is a base class for specific comparison conditions
# like Equals, NotEquals, LessThan, etc.
from boto3.dynamodb.conditions import Attr

# These create ComparisonCondition subclasses internally
condition1 = Attr('age').eq(25)  # Equals
condition2 = Attr('score').gt(90)  # GreaterThan
condition3 = Attr('name').ne('test')  # NotEquals
```

#### 29. _ForgetfulDict Class

**Function Description**: Dictionary subclass that forgets duplicate key assignments (for internal use in DynamoDB transformations).

**Import Method**:
```python
from boto3.dynamodb.transform import _ForgetfulDict
```

**Parent Class**: `dict`

**Class Signature**:
```python
class _ForgetfulDict(dict):
    """A dictionary that discards any items set on it. For use as `memo` in
    `copy.deepcopy()` when every instance of a repeated object in the deepcopied
    data structure should result in a separate copy.
    """
    
    def __setitem__(self, key, value) -> None
```

**Main Methods**:

**__setitem__()**: Override to discard any items set on the dictionary
- Parameters:
  - `key`: The key to set (ignored)
  - `value`: The value to set (ignored)
- Returns: None
- Note: This method intentionally does nothing, discarding all assignments. Used as `memo` in `copy.deepcopy()` when every instance of a repeated object should result in a separate copy.

**Usage Example**:
```python
# Internal class used for DynamoDB parameter transformation
# Prevents duplicate placeholder names in condition expressions
```

#### 30. ConditionExpressionTransformation Class

**Function Description**: Transformation class for converting condition objects into DynamoDB expression strings.

**Import Method**:
```python
from boto3.dynamodb.transform import ConditionExpressionTransformation
```

**Class Signature**:
```python
class ConditionExpressionTransformation:
    """Provides a transformation for condition expressions
    
    The ``ParameterTransformer`` class can call this class directly
    to transform the condition expressions in the parameters provided.
    """
    
    def __init__(
        self, 
        condition_builder, 
        placeholder_names, 
        placeholder_values, 
        is_key_condition=False
    ) -> None
    
    def __call__(self, value)
```

**Parameters** (__init__ parameters):
- `condition_builder`: ConditionExpressionBuilder instance
- `placeholder_names` (dict): Dictionary for attribute name placeholders
- `placeholder_values` (dict): Dictionary for attribute value placeholders
- `is_key_condition` (bool): Whether this is a key condition expression (default: False)

**Instance Attributes** (set during initialization):
- `_condition_builder`: Stored condition builder
- `_placeholder_names` (dict): Stored placeholder names
- `_placeholder_values` (dict): Stored placeholder values
- `_is_key_condition` (bool): Flag indicating if this is a key condition

**Main Methods**:

**__call__()**: Transform a condition value into an expression string
- Parameters:
  - `value`: The value to transform (ConditionBase object or other)
- Returns: str - Condition expression string if value is ConditionBase, otherwise returns the original value unchanged
- Note: This method builds the condition expression and updates the placeholder dictionaries when called with a ConditionBase object

**Usage Example**:
```python
# Used internally to transform conditions into DynamoDB expressions
from boto3.dynamodb.conditions import Attr, ConditionExpressionBuilder

builder = ConditionExpressionBuilder()
condition = Attr('age').gt(25)
expression, names, values = builder.build_expression(condition)
```

#### 31. TableResource Class

**Function Description**: Enhanced resource class for DynamoDB Table with high-level methods.

**Import Method**:
```python
from boto3.dynamodb.table import TableResource
```

**Class Signature**:
```python
class TableResource:
    """DynamoDB table resource with high-level methods"""
    
    def __init__(self, *args, **kwargs) -> None
    
    def batch_writer(self, overwrite_by_pkeys=None) -> BatchWriter
```

**Parameters** (__init__ parameters):
- `*args`: Variable positional arguments passed to parent class
- `**kwargs`: Variable keyword arguments passed to parent class

**Main Methods**:

**batch_writer()**: Create a batch writer object.
- Parameters:
  - `overwrite_by_pkeys` (list(string), optional): De-duplicate request items in buffer if match new request item on specified primary keys. i.e ``["partition_key1", "sort_key2", "sort_key3"]`` (default: None)
- Returns: BatchWriter - Context manager for batch write operations
- Note: This method creates a context manager for writing objects to Amazon DynamoDB in batch. The batch writer will automatically handle buffering and sending items in batches. In addition, the batch writer will also automatically handle any unprocessed items and resend them as needed. All you need to do is call ``put_item`` for any items you want to add, and ``delete_item`` for any items you want to delete.

**Usage Example**:
```python
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')

# TableResource provides the batch_writer method
with table.batch_writer() as batch:
    for i in range(100):
        batch.put_item(Item={'id': str(i), 'data': f'value_{i}'})
```

#### 32. BaseDocumenter Class

**Function Description**: Base class for all boto3 documentation generators.

**Import Method**:
```python
from boto3.docs.base import BaseDocumenter
```

**Class Signature**:
```python
class BaseDocumenter:
    def __init__(self, resource) -> None
    
    @property
    def class_name(self) -> str
```

**Parameters** (__init__ parameters):
- `resource` (ServiceResource): Resource object to document

**Instance Attributes** (set during initialization):
- `_resource` (ServiceResource): Stored resource reference
- `_client` (Client): Client from resource meta
- `_resource_model` (ResourceModel): Resource model from resource meta
- `_service_model` (ServiceModel): Service model from client meta
- `_resource_name` (str): Name of the resource
- `_service_name` (str): Name of the service
- `_service_docs_name` (str): Documentation name of the service
- `member_map` (OrderedDict): Ordered dictionary for member mapping
- `represents_service_resource` (bool): Whether this represents a service resource
- `_resource_class_name` (str): Class name of the resource

**Main Methods**:

**class_name** (property): Get the fully qualified class name
- `Parameters`: None
- `Returns`: str - Fully qualified class name in format '{service_docs_name}.{resource_name}'

**Usage Example**:
```python
# Base class for documentation generation
# Typically subclassed by specific documenters
```

#### 33. NestedDocumenter Class

**Function Description**: Documenter for nested resources and sub-resources.

**Import Method**:
```python
from boto3.docs.base import NestedDocumenter
```

**Parent Class**: `BaseDocumenter`

**Class Signature**:
```python
class NestedDocumenter(BaseDocumenter):
    def __init__(self, resource, root_docs_path) -> None
    
    @property
    def class_name(self) -> str
```

**Parameters** (__init__ parameters):
- `resource` (ServiceResource): Resource object to document
- `root_docs_path` (str): Root path for documentation files

**Instance Attributes** (inherits from BaseDocumenter plus):
- `_root_docs_path` (str): Stored root documentation path
- `_resource_sub_path` (str): Resource sub-path for documentation (lowercased resource name or 'service-resource')

**Main Methods**:

**class_name** (property): Get the fully qualified class name
- `Parameters`: None
- `Returns`: str - Fully qualified class name in format '{service_docs_name}.{resource_class_name}' where resource_class_name is 'ServiceResource' if resource name equals service name, otherwise the resource name

**Usage Example**:
```python
# Used internally for generating documentation for nested resources
```

#### 34. DocumentModifiedShape Class

**Function Description**: Class for modifying shape documentation in generated docs.

**Import Method**:
```python
from boto3.docs.utils import DocumentModifiedShape
```

**Class Signature**:
```python
class DocumentModifiedShape:
    """Modified shape documentation handler"""
    
    def __init__(self, shape_name, new_type, new_description, new_example_value) -> None
    
    def replace_documentation_for_matching_shape(self, event_name, section, **kwargs) -> None
    
    def _replace_documentation(self, event_name, section) -> None
```

**Parameters** (__init__ parameters):
- `shape_name` (str): Name of the shape to modify
- `new_type` (str): New type description
- `new_description` (str): New description text
- `new_example_value` (Any): New example value

**Instance Attributes** (set during initialization):
- `_shape_name` (str): Stored shape name
- `_new_type` (str): Stored new type
- `_new_description` (str): Stored new description
- `_new_example_value` (Any): Stored new example value

**Main Methods**:

**replace_documentation_for_matching_shape()**: Replace documentation for matching shapes recursively
- `Parameters`:
  - `event_name` (str): Documentation event name
  - `section` (DocumentStructure): Documentation section object
  - `**kwargs`: Additional keyword arguments
- `Returns`: None
- `Note`: Recursively searches for sections matching the shape name and replaces their documentation

**_replace_documentation()**: Internal method to replace documentation in a section
- `Parameters`:
  - `event_name` (str): Documentation event name
  - `section` (DocumentStructure): Documentation section object
- `Returns`: None
- `Note`: Private method that handles the actual documentation replacement based on event type

**Usage Example**:
```python
# Used to customize shape documentation
from boto3.docs.utils import DocumentModifiedShape

modifier = DocumentModifiedShape(
    'StreamingBody',
    'StreamingBody',
    'A file-like object representing the response data',
    'StreamingBody()'
)
```

#### 35. ResourceShapeDocumenter Class

**Function Description**: Documenter for resource shapes in response parameters.

**Import Method**:
```python
from boto3.docs.attr import ResourceShapeDocumenter
```

**Parent Class**: `ResponseParamsDocumenter`

**Class Signature**:
```python
class ResourceShapeDocumenter(ResponseParamsDocumenter):
    """Resource shape documenter"""
    EVENT_NAME = 'resource-shape'
```

**Class Attributes**:
- `EVENT_NAME` (str): Event name identifier used for resource shape documentation events. Value: 'resource-shape'

**Usage Example**:
```python
# Used internally for documenting resource shapes
```

#### 36. ActionDocstring Class

**Function Description**: Lazy-loaded docstring generator for resource action methods.

**Import Method**:
```python
from boto3.docs.docstring import ActionDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class ActionDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_action
  - `**kwargs`: Variable keyword arguments passed to document_action
- `Returns`: None
- `Note`: Calls document_action function to generate action documentation

**Usage Example**:
```python
# Used internally by boto3 to generate documentation for resource actions
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Action methods have docstrings generated by ActionDocstring
print(bucket.create.__doc__)
print(bucket.delete.__doc__)
```

#### 37. LoadReloadDocstring Class

**Function Description**: Lazy-loaded docstring generator for load() and reload() methods.

**Import Method**:
```python
from boto3.docs.docstring import LoadReloadDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class LoadReloadDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_load_reload_action
  - `**kwargs`: Variable keyword arguments passed to document_load_reload_action
- `Returns`: None
- `Note`: Calls document_load_reload_action function to generate load/reload documentation

**Usage Example**:
```python
# Used internally for load() and reload() method documentation
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# load() and reload() have docstrings generated by LoadReloadDocstring
print(bucket.load.__doc__)
print(bucket.reload.__doc__)
```

#### 38. SubResourceDocstring Class

**Function Description**: Lazy-loaded docstring generator for sub-resource factory methods.

**Import Method**:
```python
from boto3.docs.docstring import SubResourceDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class SubResourceDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_sub_resource
  - `**kwargs`: Variable keyword arguments passed to document_sub_resource
- `Returns`: None
- `Note`: Calls document_sub_resource function to generate sub-resource documentation

**Usage Example**:
```python
# Used internally for sub-resource factory method documentation
import boto3

s3 = boto3.resource('s3')

# Sub-resource factories have docstrings generated by SubResourceDocstring
print(s3.Bucket.__doc__)
print(s3.Object.__doc__)
```

#### 39. AttributeDocstring Class

**Function Description**: Lazy-loaded docstring generator for resource attribute properties.

**Import Method**:
```python
from boto3.docs.docstring import AttributeDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class AttributeDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_attribute
  - `**kwargs`: Variable keyword arguments passed to document_attribute
- `Returns`: None
- `Note`: Calls document_attribute function to generate attribute documentation

**Usage Example**:
```python
# Used internally for resource attribute documentation
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Attributes have docstrings generated by AttributeDocstring
# e.g., bucket.creation_date, bucket.name, etc.
```

#### 40. IdentifierDocstring Class

**Function Description**: Lazy-loaded docstring generator for resource identifier properties.

**Import Method**:
```python
from boto3.docs.docstring import IdentifierDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class IdentifierDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_identifier
  - `**kwargs`: Variable keyword arguments passed to document_identifier
- `Returns`: None
- `Note`: Calls document_identifier function to generate identifier documentation

**Usage Example**:
```python
# Used internally for resource identifier documentation
import boto3

ec2 = boto3.resource('ec2')
instance = ec2.Instance('i-1234567890abcdef0')

# Identifiers have docstrings generated by IdentifierDocstring
print(instance.id.__doc__)
```

#### 41. ReferenceDocstring Class

**Function Description**: Lazy-loaded docstring generator for resource reference properties.

**Import Method**:
```python
from boto3.docs.docstring import ReferenceDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class ReferenceDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_reference
  - `**kwargs`: Variable keyword arguments passed to document_reference
- `Returns`: None
- `Note`: Calls document_reference function to generate reference documentation

**Usage Example**:
```python
# Used internally for resource reference documentation
import boto3

ec2 = boto3.resource('ec2')
instance = ec2.Instance('i-1234567890abcdef0')

# References to other resources have docstrings generated by ReferenceDocstring
# e.g., instance.vpc, instance.subnet, etc.
```

#### 42. CollectionDocstring Class

**Function Description**: Lazy-loaded docstring generator for resource collection properties.

**Import Method**:
```python
from boto3.docs.docstring import CollectionDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class CollectionDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_collection_object
  - `**kwargs`: Variable keyword arguments passed to document_collection_object
- `Returns`: None
- `Note`: Calls document_collection_object function to generate collection documentation

**Usage Example**:
```python
# Used internally for collection documentation
import boto3

s3 = boto3.resource('s3')

# Collections have docstrings generated by CollectionDocstring
print(s3.buckets.__doc__)

bucket = s3.Bucket('my-bucket')
print(bucket.objects.__doc__)
```

#### 43. CollectionMethodDocstring Class

**Function Description**: Lazy-loaded docstring generator for collection method operations.

**Import Method**:
```python
from boto3.docs.docstring import CollectionMethodDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class CollectionMethodDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_collection_method
  - `**kwargs`: Variable keyword arguments passed to document_collection_method
- `Returns`: None
- `Note`: Calls document_collection_method function to generate collection method documentation

**Usage Example**:
```python
# Used internally for collection method documentation
import boto3

s3 = boto3.resource('s3')

# Collection methods have docstrings generated by CollectionMethodDocstring
print(s3.buckets.all.__doc__)
print(s3.buckets.filter.__doc__)
print(s3.buckets.limit.__doc__)
print(s3.buckets.page_size.__doc__)
```

#### 44. BatchActionDocstring Class

**Function Description**: Lazy-loaded docstring generator for batch action methods on collections.

**Import Method**:
```python
from boto3.docs.docstring import BatchActionDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class BatchActionDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_batch_action
  - `**kwargs`: Variable keyword arguments passed to document_batch_action
- `Returns`: None
- `Note`: Calls document_batch_action function to generate batch action documentation

**Usage Example**:
```python
# Used internally for batch action documentation
import boto3

ec2 = boto3.resource('ec2')
instances = ec2.instances.all()

# Batch actions have docstrings generated by BatchActionDocstring
# e.g., instances.start(), instances.stop(), instances.terminate()
```

#### 45. ResourceWaiterDocstring Class

**Function Description**: Lazy-loaded docstring generator for resource waiter methods.

**Import Method**:
```python
from boto3.docs.docstring import ResourceWaiterDocstring
```

**Parent Class**: `LazyLoadedDocstring` from botocore

**Class Signature**:
```python
class ResourceWaiterDocstring(LazyLoadedDocstring):
    def _write_docstring(self, *args, **kwargs) -> None
```

**Main Methods**:

**_write_docstring()**: Internal method that generates the docstring content
- `Parameters`:
  - `*args`: Variable positional arguments passed to document_resource_waiter
  - `**kwargs`: Variable keyword arguments passed to document_resource_waiter
- `Returns`: None
- `Note`: Calls document_resource_waiter function to generate resource waiter documentation

**Usage Example**:
```python
# Used internally for waiter method documentation
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Waiter methods have docstrings generated by ResourceWaiterDocstring
print(bucket.wait_until_exists.__doc__)
print(bucket.wait_until_not_exists.__doc__)
```

#### 46. get_version() Function

**Function Description**: Internal function in `setup.py` that extracts version string from `boto3/__init__.py` using regex.

**Location**: `setup.py` (line 23) - **Not importable by end users**

**Function Signature**:
```python
def get_version()


**Parameters**:
- None

**Return Value**:
- Returns version string extracted from `boto3/__init__.py` (e.g., '1.40.56')

**Note**: This function exists only in `setup.py` and is used during package installation. It **cannot be imported** by end users because `setup.py` is not part of the installed package. 

**For end users**: Access version using the `__version__` constant:
```python
import boto3
print(boto3.__version__)  # '1.40.56'
```

**Usage Example**:
```python
# For end users: access version directly from boto3
import boto3
print(boto3.__version__)  # '1.40.56'

# The get_version() function is only used internally in setup.py:
# In setup.py file:
# setup(
#     name='boto3',
#     version=get_version(),  # <- Called here during installation
#     ...
# )
```

#### 47. filter_python_deprecation_warnings() Function

**Function Description**: Filter and suppress Python version deprecation warnings.

**Import Method**:
```python
from boto3.compat import filter_python_deprecation_warnings
```

**Function Signature**:
```python
def filter_python_deprecation_warnings()
```

**Parameters**:
- None

**Return Value**:
- Returns None

**Usage Example**:
```python
from boto3.compat import filter_python_deprecation_warnings

# Filter Python deprecation warnings
filter_python_deprecation_warnings()
```

#### 48. is_append_mode() Function

**Function Description**: Check if a file object is opened in append mode.

**Import Method**:
```python
from boto3.compat import is_append_mode
```

**Function Signature**:
```python
def is_append_mode(fileobj)
```

**Parameters**:
- `fileobj`: File-like object to check

**Return Value**:
- Returns True if file is in append mode, False otherwise

**Usage Example**:
```python
from boto3.compat import is_append_mode

with open('file.txt', 'a') as f:
    print(is_append_mode(f))  # True

with open('file.txt', 'r') as f:
    print(is_append_mode(f))  # False
```

#### 49. import_module() Function

**Function Description**: Dynamically import a module by its full name.

**Import Method**:
```python
from boto3.utils import import_module
```

**Function Signature**:
```python
def import_module(name)
```

**Parameters**:
- `name` (str): Full module name to import (e.g., 'boto3.session')

**Return Value**:
- Returns the imported module object

**Usage Example**:
```python
from boto3.utils import import_module

# Dynamically import a module
session_module = import_module('boto3.session')
Session = session_module.Session

# Create session
session = Session()
```

#### 50. lazy_call() Function

**Function Description**: Create a lazy-callable wrapper that defers function execution until first call.

**Import Method**:
```python
from boto3.utils import lazy_call
```

**Function Signature**:
```python
def lazy_call(full_name, **kwargs)
```

**Parameters**:
- `full_name` (str): Full name of the function to lazily load (e.g., 'module.function')
- `**kwargs`: Additional keyword arguments to pass to the function when invoked

**Return Value**:
- Returns a callable wrapper that loads the function on first invocation

**Usage Example**:
```python
from boto3.utils import lazy_call

# Create lazy callable
lazy_func = lazy_call('boto3.session.Session')

# Function is loaded only when called
session = lazy_func()
```

#### 51. inject_attribute() Function

**Function Description**: Inject an attribute into a class's attributes dictionary.

**Import Method**:
```python
from boto3.utils import inject_attribute
```

**Function Signature**:
```python
def inject_attribute(class_attributes, name, value)
```

**Parameters**:
- `class_attributes` (dict): Dictionary of class attributes
- `name` (str): Attribute name to inject
- `value`: Value to assign to the attribute

**Return Value**:
- Returns None (modifies class_attributes in place)

**Usage Example**:
```python
from boto3.utils import inject_attribute

class_attrs = {}
inject_attribute(class_attrs, 'my_method', lambda self: 'Hello')

# Now class_attrs contains the injected method
```

#### 52. has_minimum_crt_version() Function

**Function Description**: Check if the AWS CRT Python library meets the minimum version requirement.

**Import Method**:
```python
from boto3.s3.transfer import has_minimum_crt_version
```

**Function Signature**:
```python
def has_minimum_crt_version(minimum_version)
```

**Parameters**:
- `minimum_version` (tuple): Minimum required version as tuple of integers (e.g., (0, 19, 18))

**Return Value**:
- Returns True if CRT is installed and meets minimum version, False otherwise

**Usage Example**:
```python
from boto3.s3.transfer import has_minimum_crt_version

# Check if CRT is available with minimum version
if has_minimum_crt_version((0, 19, 18)):
    print("CRT is available for high-performance transfers")
else:
    print("CRT not available or version too old")

# Check if any version of CRT is available
if has_minimum_crt_version((0, 0, 0)):
    print("CRT is installed")
```

#### 53. get_crt_s3_client() Function

**Function Description**: Get or create a CRT S3 client for high-performance transfers.

**Import Method**:
```python
from boto3.crt import get_crt_s3_client
```

**Function Signature**:
```python
def get_crt_s3_client(client, config)
```

**Parameters**:
- `client`: Boto3 S3 client instance
- `config`: Transfer configuration object

**Return Value**:
- Returns CRTS3Client instance

**Usage Example**:
```python
from boto3.crt import get_crt_s3_client
from boto3.s3.transfer import TransferConfig
import boto3

s3_client = boto3.client('s3')
config = TransferConfig(preferred_transfer_client='crt')

# Get CRT S3 client
crt_client = get_crt_s3_client(s3_client, config)
```

#### 53. create_crt_transfer_manager() Function

**Function Description**: Create a CRT-based transfer manager for optimized S3 operations. This function creates a high-performance transfer manager using AWS Common Runtime (CRT) library for accelerated S3 uploads and downloads with features like automatic multipart operations, connection pooling, and optimized concurrency.

**Import Method**:
```python
from boto3.crt import create_crt_transfer_manager
```

**Required Third-Party Library Imports**:
```python
# Third-party library imports from s3transfer.crt
from s3transfer.crt import (
    BotocoreCRTCredentialsWrapper,
    BotocoreCRTRequestSerializer,
    CRTTransferManager,
    acquire_crt_s3_process_lock,
    create_s3_crt_client,
)
```

**Function Signature**:
```python
def create_crt_transfer_manager(client, config) -> CRTTransferManager | None
```

**Parameters**:
- `client`: Boto3 S3 client instance
- `config`: Transfer configuration with CRT settings (must have `preferred_transfer_client='crt'`)

**Return Value**:
- Returns `CRTTransferManager` instance (from s3transfer.crt) if CRT is available and compatible, or `None` if CRT is not available, not compatible, or process lock cannot be acquired

**Related Classes and Functions**:

This function internally uses several classes and functions:

1. **get_crt_s3_client()**: Retrieves or creates the singleton CRT S3 client (returns CRTS3Client wrapper)
2. **is_crt_compatible_request()**: Checks if the boto3 client is compatible with the CRT client (validates region and credentials)
3. **CRTTransferManager** (from s3transfer.crt): The returned transfer manager class for high-performance transfers
4. **BOTOCORE_CRT_SERIALIZER**: Global singleton BotocoreCRTRequestSerializer instance for request serialization

**Workflow**:
```
create_crt_transfer_manager(client, config)
  ├─> get_crt_s3_client(client, config)
  │     ├─> acquire_crt_s3_process_lock() [from s3transfer.crt]
  │     ├─> _create_crt_request_serializer() -> BotocoreCRTRequestSerializer
  │     └─> _create_crt_s3_client() -> CRTS3Client
  │           ├─> BotocoreCRTCredentialsWrapper [from s3transfer.crt]
  │           └─> create_s3_crt_client() [from s3transfer.crt]
  ├─> is_crt_compatible_request(client, crt_s3_client)
  │     └─> compare_identity() [validates credentials match]
  └─> CRTTransferManager(crt_client, serializer) [from s3transfer.crt]
```

**Usage Example**:
```python
from boto3.crt import create_crt_transfer_manager
from boto3.s3.transfer import TransferConfig
import boto3

s3_client = boto3.client('s3', region_name='us-west-2')

# Configure for CRT transfer
config = TransferConfig(
    preferred_transfer_client='crt',
    max_concurrency=10,
    multipart_threshold=8 * 1024 * 1024  # 8MB
)

# Create CRT transfer manager
# Returns CRTTransferManager from s3transfer.crt or None
transfer_manager = create_crt_transfer_manager(s3_client, config)

if transfer_manager:
    # Use for high-performance uploads/downloads
    transfer_manager.upload('file.txt', 'my-bucket', 'key.txt')
    transfer_manager.download('my-bucket', 'key.txt', 'downloaded.txt')
else:
    # Fallback to classic transfer manager
    print("CRT not available, use classic transfer manager")
```

**Notes**:
- The function uses a singleton pattern for CRT client and serializer to avoid resource exhaustion
- CRT client is bound to a specific region and credential set; incompatible requests return None
- Process-level locking prevents multiple CRT instances in the same process

#### 55. build_param_structure() Function

**Function Description**: Build parameter structure from parameter definitions for API requests.

**Import Method**:
```python
from boto3.resources.params import build_param_structure
```

**Function Signature**:
```python
def build_param_structure(params, target, value, index=None) -> dict
```

**Parameters**:
- `params` (list): List of parameter definitions
- `target` (str): Target parameter path in the request
- `value`: Value to assign to the parameter
- `index` (str): Optional index for array parameters (default: None)

**Return Value**:
- Returns dictionary representing the built parameter structure

**Usage Example**:
```python
from boto3.resources.params import build_param_structure

# Build parameter structure for API request
params = []
result = build_param_structure(
    params, 
    'InstanceIds[0]', 
    'i-1234567890abcdef0'
)
# Result: {'InstanceIds': ['i-1234567890abcdef0']}
```

#### 56. get_data_member() Function

**Function Description**: Extract data from a parent object using a JMESPath-like expression.

**Import Method**:
```python
from boto3.resources.params import get_data_member
```

**Function Signature**:
```python
def get_data_member(parent, path) -> Any
```

**Parameters**:
- `parent`: Parent object or dictionary to extract data from
- `path` (str): Dot-notation path to the data member (e.g., 'Reservations[0].Instances')

**Return Value**:
- Returns the extracted data value or None if path doesn't exist

**Usage Example**:
```python
from boto3.resources.params import get_data_member

# Extract nested data
response = {
    'Reservations': [
        {'Instances': [{'InstanceId': 'i-123'}]}
    ]
}

instance_id = get_data_member(response, 'Reservations[0].Instances[0].InstanceId')
print(instance_id)  # 'i-123'
```

#### 57. all_not_none() Function

**Function Description**: Check if all values in an iterable are not None.

**Import Method**:
```python
from boto3.resources.response import all_not_none
```

**Function Signature**:
```python
def all_not_none(iterable) -> bool
```

**Parameters**:
- `iterable`: Iterable of values to check

**Return Value**:
- Returns True if all values are not None, False otherwise

**Usage Example**:
```python
from boto3.resources.response import all_not_none

# Check if all identifiers are present
identifiers = ['id-1', 'id-2', 'id-3']
print(all_not_none(identifiers))  # True

identifiers_with_none = ['id-1', None, 'id-3']
print(all_not_none(identifiers_with_none))  # False
```

#### 58. build_identifiers() Function

**Function Description**: Build resource identifiers from parent resource, parameters, and API response.

**Import Method**:
```python
from boto3.resources.response import build_identifiers
```

**Function Signature**:
```python
def build_identifiers(identifiers, parent, params=None, raw_response=None) -> list
```

**Parameters**:
- `identifiers` (list): List of identifier definitions
- `parent`: Parent resource object
- `params` (dict): Request parameters
- `raw_response` (dict): Raw API response

**Return Value**:
- Returns dictionary mapping identifier names to their values

**Usage Example**:
```python
from boto3.resources.response import build_identifiers

# Build identifiers for a resource
identifiers = [
    {'name': 'BucketName', 'memberName': 'Name'}
]
result = build_identifiers(identifiers, parent, params, response)
# Result: {'BucketName': 'my-bucket'}
```

#### 59. build_empty_response() Function

**Function Description**: Build an empty response structure based on service model for operations with no output.

**Import Method**:
```python
from boto3.resources.response import build_empty_response
```

**Function Signature**:
```python
def build_empty_response(search_path, operation_name, service_model) -> dict | list | None
```

**Parameters**:
- `search_path` (str): JMESPath expression for response search
- `operation_name` (str): Name of the API operation
- `service_model`: Botocore service model object

**Return Value**:
- Returns empty dictionary or list based on the expected response structure

**Usage Example**:
```python
from boto3.resources.response import build_empty_response

# Build empty response for operations with no output
empty_response = build_empty_response(
    'Instances[]',
    'DescribeInstances',
    service_model
)
```

#### 60. register_high_level_interface() Function

**Function Description**: Register DynamoDB high-level interface transformations for Table resources.

**Import Method**:
```python
from boto3.dynamodb.transform import register_high_level_interface
```

**Function Signature**:
```python
def register_high_level_interface(base_classes, **kwargs) -> None
```

**Parameters**:
- `base_classes` (list): List of base classes to enhance with high-level interface
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies base_classes in place by inserting DynamoDBHighLevelResource)

**Usage Example**:
```python
from boto3.dynamodb.transform import register_high_level_interface

# Register high-level interface for DynamoDB
base_classes = {'Table': TableClass}
register_high_level_interface(base_classes)
# Now Table class has enhanced methods for condition expressions
```

#### 61. copy_dynamodb_params() Function

**Function Description**: Create a deep copy of DynamoDB parameters to avoid mutation.

**Import Method**:
```python
from boto3.dynamodb.transform import copy_dynamodb_params
```

**Function Signature**:
```python
def copy_dynamodb_params(params, **kwargs) -> dict
```

**Parameters**:
- `params` (dict): DynamoDB operation parameters to copy
- `**kwargs`: Additional keyword arguments (unused)

**Return Value**:
- Returns deep copy of the parameters dictionary using _ForgetfulDict as memo

**Usage Example**:
```python
from boto3.dynamodb.transform import copy_dynamodb_params

original_params = {
    'TableName': 'my-table',
    'Key': {'id': '123'},
    'FilterExpression': 'age > 25'
}

# Create a safe copy
params_copy = copy_dynamodb_params(original_params)
params_copy['TableName'] = 'other-table'
# original_params remains unchanged
```

#### 62. register_table_methods() Function

**Function Description**: Register additional methods on DynamoDB Table resource class.

**Import Method**:
```python
from boto3.dynamodb.table import register_table_methods
```

**Function Signature**:
```python
def register_table_methods(base_classes, **kwargs) -> None
```

**Parameters**:
- `base_classes`: List of base classes to enhance
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies base_classes in place)

**Usage Example**:
```python
# This is called internally during DynamoDB resource creation
from boto3.dynamodb.table import register_table_methods

base_classes = {'Table': TableClass}
register_table_methods(base_classes)
# Now Table class has batch_writer() method
```

#### 63. generate_docs() Function

**Function Description**: Generate documentation files for all boto3 services and resources.

**Import Method**:
```python
from boto3.docs import generate_docs
```

**Function Signature**:
```python
def generate_docs(root_dir, session) -> None
```

**Parameters**:
- `root_dir` (str): Root directory path where documentation will be generated
- `session`: Boto3 Session instance

**Return Value**:
- Returns None (generates documentation files in specified directory)

**Usage Example**:
```python
from boto3.docs import generate_docs
import boto3

# Generate documentation for all services
session = boto3.Session()
generate_docs('./docs', session)
# This creates RST documentation files in ./docs directory
```

#### 64. document_resource_waiter() Function

**Function Description**: Generate documentation for a resource waiter method.

**Import Method**:
```python
from boto3.docs.waiter import document_resource_waiter
```

**Function Signature**:
```python
def document_resource_waiter(
    section,
    resource_name,
    event_emitter,
    service_model,
    resource_waiter_model,
    service_waiter_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_name` (str): Name of the resource
- `event_emitter`: Event system for documentation events
- `service_model`: Botocore service model
- `resource_waiter_model`: Resource waiter model definition
- `service_waiter_model`: Service waiter model
- `include_signature` (bool): Whether to include method signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
# Used internally for documentation generation
from boto3.docs.waiter import document_resource_waiter

document_resource_waiter(
    section,
    's3',
    event_emitter,
    service_model,
    waiter_model,
    service_waiter_model
)
```

#### 65. document_action() Function

**Function Description**: Generate documentation for a resource action method.

**Import Method**:
```python
from boto3.docs.action import document_action
```

**Function Signature**:
```python
def document_action(
    section,
    resource_name,
    event_emitter,
    action_model,
    service_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_name` (str): Name of the resource
- `event_emitter`: Event system for documentation events
- `action_model`: Action model definition
- `service_model`: Botocore service model
- `include_signature` (bool): Whether to include method signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
# Used internally for documentation generation
from boto3.docs.action import document_action

document_action(
    section,
    'Bucket',
    event_emitter,
    action_model,
    service_model
)
```

#### 66. document_load_reload_action() Function

**Function Description**: Generate documentation for load() and reload() resource methods.

**Import Method**:
```python
from boto3.docs.action import document_load_reload_action
```

**Function Signature**:
```python
def document_load_reload_action(
    section,
    action_name,
    resource_name,
    event_emitter,
    load_model,
    service_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `action_name` (str): Name of the action ('load' or 'reload')
- `resource_name` (str): Name of the resource
- `event_emitter`: Event system for documentation events
- `load_model`: Load action model definition
- `service_model`: Botocore service model
- `include_signature` (bool): Whether to include method signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.action import document_load_reload_action

# Generate documentation for load method
document_load_reload_action(
    section,
    'load',
    'Bucket',
    event_emitter,
    load_model,
    service_model
)
```

#### 67. is_resource_action() Function

**Function Description**: Check if a given handler is a resource action.

**Import Method**:
```python
from boto3.docs.utils import is_resource_action
```

**Function Signature**:
```python
def is_resource_action(action_handle) -> bool
```

**Parameters**:
- `action_handle`: Action handler to check

**Return Value**:
- Returns True if the handler is a resource action, False otherwise

**Usage Example**:
```python
from boto3.docs.utils import is_resource_action
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Check if a method is a resource action
print(is_resource_action(bucket.create))  # True
print(is_resource_action(bucket.name))  # False (it's an identifier)
```

#### 68. get_resource_public_actions() Function

**Function Description**: Get all public action methods from a resource class.

**Import Method**:
```python
from boto3.docs.utils import get_resource_public_actions
```

**Function Signature**:
```python
def get_resource_public_actions(resource_class) -> list
```

**Parameters**:
- `resource_class`: Resource class to extract actions from

**Return Value**:
- Returns list of public action method names

**Usage Example**:
```python
from boto3.docs.utils import get_resource_public_actions
import boto3

s3 = boto3.resource('s3')
BucketClass = type(s3.Bucket('test'))

# Get all public actions
actions = get_resource_public_actions(BucketClass)
print(actions)  # ['create', 'delete', 'load', 'reload', ...]
```

#### 69. get_identifier_values_for_example() Function

**Function Description**: Generate example values for resource identifiers in documentation.

**Import Method**:
```python
from boto3.docs.utils import get_identifier_values_for_example
```

**Function Signature**:
```python
def get_identifier_values_for_example(identifier_names) -> str
```

**Parameters**:
- `identifier_names` (list): List of identifier names

**Return Value**:
- Returns list of example values for the identifiers

**Usage Example**:
```python
from boto3.docs.utils import get_identifier_values_for_example

# Get example values
identifiers = ['bucket_name', 'key']
examples = get_identifier_values_for_example(identifiers)
print(examples)  # ['my-bucket', 'my-key']
```

#### 70. get_identifier_args_for_signature() Function

**Function Description**: Generate identifier arguments string for method signatures in documentation.

**Import Method**:
```python
from boto3.docs.utils import get_identifier_args_for_signature
```

**Function Signature**:
```python
def get_identifier_args_for_signature(identifier_names) -> str
```

**Parameters**:
- `identifier_names` (list): List of identifier names

**Return Value**:
- Returns formatted string of identifier arguments for method signature

**Usage Example**:
```python
from boto3.docs.utils import get_identifier_args_for_signature

# Generate signature arguments
identifiers = ['bucket_name', 'key']
args = get_identifier_args_for_signature(identifiers)
print(args)  # "bucket_name, key"
```

#### 71. get_identifier_description() Function

**Function Description**: Get description text for a resource identifier in documentation.

**Import Method**:
```python
from boto3.docs.utils import get_identifier_description
```

**Function Signature**:
```python
def get_identifier_description(resource_name, identifier_name) -> str
```

**Parameters**:
- `resource_name` (str): Name of the resource
- `identifier_name` (str): Name of the identifier

**Return Value**:
- Returns description string for the identifier

**Usage Example**:
```python
from boto3.docs.utils import get_identifier_description

# Get identifier description
desc = get_identifier_description('Bucket', 'name')
print(desc)  # "The Bucket's name identifier"
```

#### 72. add_resource_type_overview() Function

**Function Description**: Add an overview section for a resource type in documentation.

**Import Method**:
```python
from boto3.docs.utils import add_resource_type_overview
```

**Function Signature**:
```python
def add_resource_type_overview(
    section,
    resource_type,
    description,
    intro_link=None
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_type` (str): Type of resource (e.g., 'identifiers', 'attributes')
- `description` (str): Description text for the resource type
- `intro_link` (str): Optional link to introduction (default: None)

**Return Value**:
- Returns None (writes to documentation section)

**Usage Example**:
```python
from boto3.docs.utils import add_resource_type_overview

add_resource_type_overview(
    section,
    'Identifiers',
    'Identifiers uniquely identify a resource instance',
    intro_link='#identifiers'
)
```

#### 73. document_collection_object() Function

**Function Description**: Generate documentation for a collection object.

**Import Method**:
```python
from boto3.docs.collection import document_collection_object
```

**Function Signature**:
```python
def document_collection_object(
    section,
    collection_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `collection_model`: Collection model definition
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.collection import document_collection_object

# Generate collection documentation
document_collection_object(
    section,
    collection_model,
    include_signature=True
)
```

#### 74. document_batch_action() Function

**Function Description**: Generate documentation for a batch action on a collection.

**Import Method**:
```python
from boto3.docs.collection import document_batch_action
```

**Function Signature**:
```python
def document_batch_action(
    section,
    resource_name,
    event_emitter,
    batch_action_model,
    service_model,
    collection_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_name` (str): Name of the resource
- `event_emitter`: Event system for documentation events
- `batch_action_model`: Batch action model definition
- `service_model`: Botocore service model
- `collection_model`: Collection model definition
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.collection import document_batch_action

# Document a batch action like instances.start()
document_batch_action(
    section,
    'Instance',
    event_emitter,
    batch_action_model,
    service_model,
    collection_model
)
```

#### 75. document_collection_method() Function

**Function Description**: Generate documentation for collection methods like all(), filter(), limit().

**Import Method**:
```python
from boto3.docs.collection import document_collection_method
```

**Function Signature**:
```python
def document_collection_method(
    section,
    resource_name,
    action_name,
    event_emitter,
    collection_model,
    service_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_name` (str): Name of the resource
- `action_name` (str): Name of the collection method (e.g., 'all', 'filter')
- `event_emitter`: Event system for documentation events
- `collection_model`: Collection model definition
- `service_model`: Botocore service model
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.collection import document_collection_method

# Document collection methods
document_collection_method(
    section,
    'Bucket',
    'all',
    event_emitter,
    collection_model,
    service_model
)
```

#### 76. document_model_driven_resource_method() Function

**Function Description**: Generate documentation for model-driven resource methods.

**Import Method**:
```python
from boto3.docs.method import document_model_driven_resource_method
```

**Function Signature**:
```python
def document_model_driven_resource_method(
    section,
    method_name,
    operation_model,
    event_emitter,
    method_description=None,
    example_prefix=None,
    include_input=None,
    include_output=None,
    exclude_input=None,
    exclude_output=None,
    document_output=True,
    resource_action_model=None,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `method_name` (str): Name of the method
- `operation_model`: Botocore operation model
- `event_emitter`: Event system for documentation events
- `method_description` (str): Optional method description
- `example_prefix` (str): Prefix for example code
- `include_input` (list): Input parameters to include
- `include_output` (list): Output fields to include
- `exclude_input` (list): Input parameters to exclude
- `exclude_output` (list): Output fields to exclude
- `document_output` (bool): Whether to document output (default: True)
- `resource_action_model`: Resource action model
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.method import document_model_driven_resource_method

document_model_driven_resource_method(
    section,
    'put_object',
    operation_model,
    event_emitter,
    method_description='Upload an object to S3'
)
```

#### 77. create_request_parameters() Function

**Function Description**: Create request parameters from parent resource and parameter model.

**Import Method**:
```python
from boto3.resources.params import create_request_parameters
```

**Function Signature**:
```python
def create_request_parameters(
    parent,
    request_model,
    params=None,
    index=None
) -> dict
```

**Parameters**:
- `parent`: Parent resource object
- `request_model`: Request model definition
- `params` (dict): Optional existing parameters (default: None)
- `index` (str): Optional index for array parameters (default: None)

**Return Value**:
- Returns dictionary of request parameters

**Usage Example**:
```python
from boto3.resources.params import create_request_parameters

# Create request parameters for an API call
params = create_request_parameters(
    parent_resource,
    request_model,
    {'MaxResults': 10}
)
```

#### 78. document_attribute() Function

**Function Description**: Generate documentation for a resource attribute.

**Import Method**:
```python
from boto3.docs.attr import document_attribute
```

**Function Signature**:
```python
def document_attribute(
    section,
    service_name,
    resource_name,
    attr_name,
    event_emitter,
    attr_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `service_name` (str): Name of the AWS service
- `resource_name` (str): Name of the resource
- `attr_name` (str): Name of the attribute
- `event_emitter`: Event system for documentation events
- `attr_model`: Attribute model definition
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.attr import document_attribute

# Document a resource attribute
document_attribute(
    section,
    's3',
    'Bucket',
    'creation_date',
    event_emitter,
    attr_model
)
```

#### 79. document_identifier() Function

**Function Description**: Generate documentation for a resource identifier.

**Import Method**:
```python
from boto3.docs.attr import document_identifier
```

**Function Signature**:
```python
def document_identifier(
    section,
    resource_name,
    identifier_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_name` (str): Name of the resource
- `identifier_model`: Identifier model definition
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.attr import document_identifier

# Document a resource identifier
document_identifier(
    section,
    'Bucket',
    identifier_model
)
```

#### 80. document_reference() Function

**Function Description**: Generate documentation for a resource reference.

**Import Method**:
```python
from boto3.docs.attr import document_reference
```

**Function Signature**:
```python
def document_reference(
    section,
    reference_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `reference_model`: Reference model definition
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.attr import document_reference

# Document a resource reference
document_reference(
    section,
    reference_model
)
```

#### 81. document_sub_resource() Function

**Function Description**: Generate documentation for a sub-resource factory method.

**Import Method**:
```python
from boto3.docs.subresource import document_sub_resource
```

**Function Signature**:
```python
def document_sub_resource(
    section,
    resource_name,
    sub_resource_model,
    service_model,
    include_signature=True
) -> None
```

**Parameters**:
- `section`: Documentation section object to write to
- `resource_name` (str): Name of the parent resource
- `sub_resource_model`: Sub-resource model definition
- `service_model`: Botocore service model
- `include_signature` (bool): Whether to include signature (default: True)

**Return Value**:
- Returns None (writes documentation to section)

**Usage Example**:
```python
from boto3.docs.subresource import document_sub_resource

# Document a sub-resource like Bucket() or Object()
document_sub_resource(
    section,
    'S3',
    sub_resource_model,
    service_model
)
```

#### 82. inject_create_tags() Function

**Function Description**: Inject create_tags() method into EC2 resource classes.

**Import Method**:
```python
from boto3.ec2.createtags import inject_create_tags
```

**Function Signature**:
```python
def inject_create_tags(event_name, class_attributes, **kwargs) -> None
```

**Parameters**:
- `event_name` (str): Event name for the injection
- `class_attributes` (dict): Dictionary of class attributes to inject into
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies class_attributes in place)

**Usage Example**:
```python
# This is called internally during EC2 resource creation
from boto3.ec2.createtags import inject_create_tags

class_attrs = {}
inject_create_tags('event.name', class_attrs)
# Now class_attrs contains the create_tags method
```

#### 83. inject_delete_tags() Function

**Function Description**: Inject delete_tags() method into EC2 resource classes.

**Import Method**:
```python
from boto3.ec2.deletetags import inject_delete_tags
```

**Function Signature**:
```python
def inject_delete_tags(event_emitter, **kwargs) -> None
```

**Parameters**:
- `event_emitter`: Event system for registration
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (registers delete_tags method)

**Usage Example**:
```python
# This is called internally during EC2 resource creation
from boto3.ec2.deletetags import inject_delete_tags

inject_delete_tags(event_emitter)
# Registers delete_tags method for EC2 resources
```

#### 84. get_resource_ignore_params() Function

**Function Description**: Get list of parameters to ignore when documenting resource methods.

**Import Method**:
```python
from boto3.docs.utils import get_resource_ignore_params
```

**Function Signature**:
```python
def get_resource_ignore_params(params) -> list
```

**Parameters**:
- `params` (list): List of parameter names

**Return Value**:
- Returns list of parameter names that should be ignored in documentation

**Usage Example**:
```python
from boto3.docs.utils import get_resource_ignore_params

# Get parameters to ignore
all_params = ['Bucket', 'Key', 'Body', 'internal_param']
ignore_list = get_resource_ignore_params(all_params)
# Returns parameters that shouldn't be documented
```

#### 85. create_transfer_manager() Function

**Function Description**: Create an S3 transfer manager (either CRT-based or classic).

**Import Method**:
```python
from boto3.s3.transfer import create_transfer_manager
```

**Function Signature**:
```python
def create_transfer_manager(
    client,
    config,
    osutil=None
) -> S3Transfer
```

**Parameters**:
- `client`: Boto3 S3 client instance
- `config` (TransferConfig): Optional transfer configuration (default: None)
- `osutil`: Optional OS utility object (default: None)

**Return Value**:
- Returns S3Transfer or CRTTransferManager based on configuration

**Usage Example**:
```python
from boto3.s3.transfer import create_transfer_manager, TransferConfig
import boto3

s3_client = boto3.client('s3')
config = TransferConfig(
    max_concurrency=10,
    multipart_threshold=8 * 1024 * 1024
)

# Create appropriate transfer manager
transfer_manager = create_transfer_manager(s3_client, config)
transfer_manager.upload_file('file.txt', 'bucket', 'key')
```

#### 86. inject_s3_transfer_methods() Function

**Function Description**: Inject S3 transfer methods (upload_file, download_file, copy) into S3 client class.

**Import Method**:
```python
from boto3.s3.inject import inject_s3_transfer_methods
```

**Function Signature**:
```python
def inject_s3_transfer_methods(class_attributes, **kwargs) -> None
```

**Parameters**:
- `class_attributes` (dict): Dictionary of class attributes to inject methods into
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies class_attributes in place)

**Usage Example**:
```python
# This is called internally during S3 client creation
# to add upload_file(), download_file(), copy() methods
```

#### 87. inject_bucket_methods() Function

**Function Description**: Inject S3 bucket-specific transfer methods into Bucket resource class.

**Import Method**:
```python
from boto3.s3.inject import inject_bucket_methods
```

**Function Signature**:
```python
def inject_bucket_methods(class_attributes, **kwargs) -> None
```

**Parameters**:
- `class_attributes` (dict): Dictionary of class attributes to inject methods into
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies class_attributes in place)

**Usage Example**:
```python
# This is called internally during S3 Bucket resource creation
# to add upload_file(), download_file(), copy() methods
```

#### 88. inject_object_methods() Function

**Function Description**: Inject S3 object-specific transfer methods into Object resource class.

**Import Method**:
```python
from boto3.s3.inject import inject_object_methods
```

**Function Signature**:
```python
def inject_object_methods(class_attributes, **kwargs) -> None
```

**Parameters**:
- `class_attributes` (dict): Dictionary of class attributes to inject methods into
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies class_attributes in place)

**Usage Example**:
```python
# This is called internally during S3 Object resource creation
# to add upload_file(), download_file(), copy() methods
```

#### 89. inject_object_summary_methods() Function

**Function Description**: Inject methods into S3 ObjectSummary resource class.

**Import Method**:
```python
from boto3.s3.inject import inject_object_summary_methods
```

**Function Signature**:
```python
def inject_object_summary_methods(class_attributes, **kwargs) -> None
```

**Parameters**:
- `class_attributes` (dict): Dictionary of class attributes to inject methods into
- `**kwargs`: Additional keyword arguments

**Return Value**:
- Returns None (modifies class_attributes in place)

**Usage Example**:
```python
# This is called internally during S3 ObjectSummary resource creation
# to add load() and other methods
```

#### 90. bucket_load() Function

**Function Description**: Custom load implementation for S3 Bucket resource.

**Import Method**:
```python
from boto3.s3.inject import bucket_load
```

**Function Signature**:
```python
def bucket_load(self, *args, **kwargs) -> None
```

**Parameters**:
- `self`: Bucket resource instance

**Return Value**:
- Returns None (loads bucket metadata)

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Load bucket metadata
bucket.load()
# Now bucket.creation_date and other attributes are available
```

#### 91. object_summary_load() Function

**Function Description**: Custom load implementation for S3 ObjectSummary resource.

**Import Method**:
```python
from boto3.s3.inject import object_summary_load
```

**Function Signature**:
```python
def object_summary_load(self, *args, **kwargs) -> None
```

**Parameters**:
- `self`: ObjectSummary resource instance

**Return Value**:
- Returns None (loads object metadata)

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

for obj_summary in bucket.objects.all():
    obj_summary.load()
    # Now full object metadata is available
```

#### 92. upload_file() Function

**Function Description**: Upload a file to S3 using the S3 client's transfer manager.

**Import Method**:
```python
from boto3.s3.inject import upload_file
# Or use directly on client
client.upload_file(...)
```

**Function Signature**:
```python
def upload_file(
    self,
    Filename,
    Bucket,
    Key,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: S3 client instance
- `Filename` (str): Path to local file to upload
- `Bucket` (str): Name of the S3 bucket
- `Key` (str): S3 object key
- `ExtraArgs` (dict): Extra arguments like metadata, ACL (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3_client = boto3.client('s3')

# Upload a file
s3_client.upload_file(
    'local_file.txt',
    'my-bucket',
    'remote_file.txt',
    ExtraArgs={'ACL': 'public-read'}
)
```

#### 93. download_file() Function

**Function Description**: Download a file from S3 using the S3 client's transfer manager.

**Import Method**:
```python
from boto3.s3.inject import download_file
# Or use directly on client
client.download_file(...)
```

**Function Signature**:
```python
def download_file(
    self,
    Bucket,
    Key,
    Filename,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: S3 client instance
- `Bucket` (str): Name of the S3 bucket
- `Key` (str): S3 object key
- `Filename` (str): Path to save downloaded file
- `ExtraArgs` (dict): Extra arguments for the download (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3_client = boto3.client('s3')

# Download a file
s3_client.download_file(
    'my-bucket',
    'remote_file.txt',
    'local_file.txt'
)
```

#### 94. copy() Function

**Function Description**: Copy an S3 object from one location to another.

**Import Method**:
```python
from boto3.s3.inject import copy
# Or use directly on client
client.copy(...)
```

**Function Signature**:
```python
def copy(
    self,
    CopySource,
    Bucket,
    Key,
    ExtraArgs=None,
    Callback=None,
    SourceClient=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: S3 client instance
- `CopySource` (dict): Dictionary with 'Bucket' and 'Key' of source object
- `Bucket` (str): Destination bucket name
- `Key` (str): Destination object key
- `ExtraArgs` (dict): Extra arguments for the copy (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `SourceClient`: Optional source client if copying from different region (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3_client = boto3.client('s3')

# Copy an object
s3_client.copy(
    CopySource={'Bucket': 'source-bucket', 'Key': 'source-key'},
    Bucket='dest-bucket',
    Key='dest-key'
)
```

#### 95. upload_fileobj() Function

**Function Description**: Upload a file-like object to S3.

**Import Method**:
```python
from boto3.s3.inject import upload_fileobj
# Or use directly on client
client.upload_fileobj(...)
```

**Function Signature**:
```python
def upload_fileobj(
    self,
    Fileobj,
    Bucket,
    Key,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: S3 client instance
- `Fileobj`: File-like object to upload (must be opened in binary mode)
- `Bucket` (str): Name of the S3 bucket
- `Key` (str): S3 object key
- `ExtraArgs` (dict): Extra arguments like metadata, ACL (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3_client = boto3.client('s3')

# Upload file object
with open('file.txt', 'rb') as f:
    s3_client.upload_fileobj(f, 'my-bucket', 'remote_file.txt')

# Upload in-memory bytes
from io import BytesIO
data = BytesIO(b'Hello, S3!')
s3_client.upload_fileobj(data, 'my-bucket', 'greeting.txt')
```

#### 96. download_fileobj() Function

**Function Description**: Download an S3 object to a file-like object.

**Import Method**:
```python
from boto3.s3.inject import download_fileobj
# Or use directly on client
client.download_fileobj(...)
```

**Function Signature**:
```python
def download_fileobj(
    self,
    Bucket,
    Key,
    Fileobj,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: S3 client instance
- `Bucket` (str): Name of the S3 bucket
- `Key` (str): S3 object key
- `Fileobj`: File-like object to write to (must be opened in binary mode)
- `ExtraArgs` (dict): Extra arguments for the download (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3
from io import BytesIO

s3_client = boto3.client('s3')

# Download to file object
with open('file.txt', 'wb') as f:
    s3_client.download_fileobj('my-bucket', 'remote_file.txt', f)

# Download to memory
buffer = BytesIO()
s3_client.download_fileobj('my-bucket', 'data.bin', buffer)
data = buffer.getvalue()
```

#### 97. bucket_upload_file() Function

**Function Description**: Upload a file to S3 using Bucket resource's transfer manager.

**Import Method**:
```python
from boto3.s3.inject import bucket_upload_file
# Or use directly on bucket
bucket.upload_file(...)
```

**Function Signature**:
```python
def bucket_upload_file(
    self,
    Filename,
    Key,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Bucket resource instance
- `Filename` (str): Path to local file to upload
- `Key` (str): S3 object key
- `ExtraArgs` (dict): Extra arguments like metadata, ACL (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Upload file using bucket resource
bucket.upload_file('local_file.txt', 'remote_file.txt')
```

#### 98. bucket_download_file() Function

**Function Description**: Download a file from S3 using Bucket resource's transfer manager.

**Import Method**:
```python
from boto3.s3.inject import bucket_download_file
# Or use directly on bucket
bucket.download_file(...)
```

**Function Signature**:
```python
def bucket_download_file(
    self,
    Key,
    Filename,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Bucket resource instance
- `Key` (str): S3 object key
- `Filename` (str): Path to save downloaded file
- `ExtraArgs` (dict): Extra arguments for the download (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Download file using bucket resource
bucket.download_file('remote_file.txt', 'local_file.txt')
```

#### 99. object_upload_file() Function

**Function Description**: Upload a file to S3 using Object resource's transfer manager.

**Import Method**:
```python
from boto3.s3.inject import object_upload_file
# Or use directly on object
obj.upload_file(...)
```

**Function Signature**:
```python
def object_upload_file(
    self,
    Filename,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Object resource instance
- `Filename` (str): Path to local file to upload
- `ExtraArgs` (dict): Extra arguments like metadata, ACL (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
obj = s3.Object('my-bucket', 'remote_file.txt')

# Upload file using object resource
obj.upload_file('local_file.txt')
```

#### 100. object_download_file() Function

**Function Description**: Download an S3 object using Object resource's transfer manager.

**Import Method**:
```python
from boto3.s3.inject import object_download_file
# Or use directly on object
obj.download_file(...)
```

**Function Signature**:
```python
def object_download_file(
    self,
    Filename,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Object resource instance
- `Filename` (str): Path to save downloaded file
- `ExtraArgs` (dict): Extra arguments for the download (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
obj = s3.Object('my-bucket', 'remote_file.txt')

# Download file using object resource
obj.download_file('local_file.txt')
```

#### 101. bucket_copy() Function

**Function Description**: Copy an object within or between buckets using Bucket resource.

**Import Method**:
```python
from boto3.s3.inject import bucket_copy
# Or use directly on bucket
bucket.copy(...)
```

**Function Signature**:
```python
def bucket_copy(
    self,
    CopySource,
    Key,
    ExtraArgs=None,
    Callback=None,
    SourceClient=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Bucket resource instance
- `CopySource` (dict): Dictionary with 'Bucket' and 'Key' of source object
- `Key` (str): Destination object key in this bucket
- `ExtraArgs` (dict): Extra arguments for the copy (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `SourceClient`: Optional source client if copying from different region (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Copy object to this bucket
bucket.copy(
    CopySource={'Bucket': 'source-bucket', 'Key': 'source-key'},
    Key='dest-key'
)
```

#### 102. object_copy() Function

**Function Description**: Copy data to this S3 object from another location using Object resource.

**Import Method**:
```python
from boto3.s3.inject import object_copy
# Or use directly on object
obj.copy(...)
```

**Function Signature**:
```python
def object_copy(
    self,
    CopySource,
    ExtraArgs=None,
    Callback=None,
    SourceClient=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Object resource instance
- `CopySource` (dict): Dictionary with 'Bucket' and 'Key' of source object
- `ExtraArgs` (dict): Extra arguments for the copy (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `SourceClient`: Optional source client if copying from different region (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
obj = s3.Object('my-bucket', 'dest-key')

# Copy from another object
obj.copy(CopySource={'Bucket': 'source-bucket', 'Key': 'source-key'})
```

#### 103. bucket_upload_fileobj() Function

**Function Description**: Upload a file-like object to S3 using Bucket resource.

**Import Method**:
```python
from boto3.s3.inject import bucket_upload_fileobj
# Or use directly on bucket
bucket.upload_fileobj(...)
```

**Function Signature**:
```python
def bucket_upload_fileobj(
    self,
    Fileobj,
    Key,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Bucket resource instance
- `Fileobj`: File-like object to upload (must be opened in binary mode)
- `Key` (str): S3 object key
- `ExtraArgs` (dict): Extra arguments like metadata, ACL (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3
from io import BytesIO

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Upload file object
with open('file.txt', 'rb') as f:
    bucket.upload_fileobj(f, 'remote_file.txt')
```

#### 104. object_upload_fileobj() Function

**Function Description**: Upload a file-like object to this S3 object using Object resource.

**Import Method**:
```python
from boto3.s3.inject import object_upload_fileobj
# Or use directly on object
obj.upload_fileobj(...)
```

**Function Signature**:
```python
def object_upload_fileobj(
    self,
    Fileobj,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Object resource instance
- `Fileobj`: File-like object to upload (must be opened in binary mode)
- `ExtraArgs` (dict): Extra arguments like metadata, ACL (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3
from io import BytesIO

s3 = boto3.resource('s3')
obj = s3.Object('my-bucket', 'data.json')

# Upload from memory
data = BytesIO(b'{"key": "value"}')
obj.upload_fileobj(data)
```

#### 105. disable_threading_if_append_mode() Function

**Function Description**: Disable threading in transfer config if file object is in append mode.

**Import Method**:
```python
from boto3.s3.inject import disable_threading_if_append_mode
```

**Function Signature**:
```python
def disable_threading_if_append_mode(config, fileobj) -> TransferConfig
```

**Parameters**:
- `config` (TransferConfig): Transfer configuration object
- `fileobj`: File-like object to check

**Return Value**:
- Returns modified TransferConfig with use_threads=False if fileobj is in append mode

**Usage Example**:
```python
from boto3.s3.inject import disable_threading_if_append_mode
from boto3.s3.transfer import TransferConfig

config = TransferConfig(use_threads=True)

with open('file.txt', 'a') as f:
    # Automatically disables threading for append mode
    config = disable_threading_if_append_mode(config, f)
    print(config.use_threads)  # False
```

#### 106. bucket_download_fileobj() Function

**Function Description**: Download an S3 object to a file-like object using Bucket resource.

**Import Method**:
```python
from boto3.s3.inject import bucket_download_fileobj
# Or use directly on bucket
bucket.download_fileobj(...)
```

**Function Signature**:
```python
def bucket_download_fileobj(
    self,
    Key,
    Fileobj,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Bucket resource instance
- `Key` (str): S3 object key
- `Fileobj`: File-like object to write to (must be opened in binary mode)
- `ExtraArgs` (dict): Extra arguments for the download (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3
from io import BytesIO

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Download to file object
with open('file.txt', 'wb') as f:
    bucket.download_fileobj('remote_file.txt', f)

# Download to memory
buffer = BytesIO()
bucket.download_fileobj('data.bin', buffer)
```

#### 107. object_download_fileobj() Function

**Function Description**: Download this S3 object to a file-like object using Object resource.

**Import Method**:
```python
from boto3.s3.inject import object_download_fileobj
# Or use directly on object
obj.download_fileobj(...)
```

**Function Signature**:
```python
def object_download_fileobj(
    self,
    Fileobj,
    ExtraArgs=None,
    Callback=None,
    Config=None
) -> None
```

**Parameters**:
- `self`: Object resource instance
- `Fileobj`: File-like object to write to (must be opened in binary mode)
- `ExtraArgs` (dict): Extra arguments for the download (default: None)
- `Callback` (callable): Progress callback function (default: None)
- `Config` (TransferConfig): Transfer configuration (default: None)

**Return Value**:
- Returns None

**Usage Example**:
```python
import boto3
from io import BytesIO

s3 = boto3.resource('s3')
obj = s3.Object('my-bucket', 'data.json')

# Download to memory
buffer = BytesIO()
obj.download_fileobj(buffer)
data = buffer.getvalue()
```

#### 108. is_crt_compatible_request() Function

**Function Description**: Check if a request is compatible with CRT transfer.

**Import Method**:
```python
from boto3.crt import is_crt_compatible_request
```

**Function Signature**:
```python
def is_crt_compatible_request(client, crt_s3_client) -> bool
```

**Parameters**:
- `client`: Boto3 S3 client instance
- `crt_s3_client`: CRT S3 client instance

**Return Value**:
- Returns True if request can use CRT, False otherwise

**Usage Example**:
```python
from boto3.crt import is_crt_compatible_request, get_crt_s3_client
import boto3

s3_client = boto3.client('s3')
crt_client = get_crt_s3_client(s3_client, config)

# Check compatibility
compatible = is_crt_compatible_request(s3_client, crt_client)
```

#### 109. compare_identity() Function

**Function Description**: Compare boto3 credentials with CRT credentials for identity matching.

**Import Method**:
```python
from boto3.crt import compare_identity
```

**Function Signature**:
```python
def compare_identity(boto3_creds, crt_s3_creds) -> bool
```

**Parameters**:
- `boto3_creds`: Boto3 credentials object
- `crt_s3_creds`: CRT S3 credentials object

**Return Value**:
- Returns True if credentials match, False otherwise

**Usage Example**:
```python
from boto3.crt import compare_identity

# Compare credentials
match = compare_identity(boto3_credentials, crt_credentials)
```

#### 110. client() Function

**Function Description**: Module-level function to create an AWS service client using the default session.

**Import Method**:
```python
import boto3
```

**Function Signature**:
```python
def client(*args, **kwargs) -> BaseClient
```

**Parameters**:
- `*args`: Positional arguments, first argument is service_name (str), e.g., 's3', 'ec2'
- `**kwargs`: Additional arguments passed to Session.client() (region_name, api_version, config, etc.)

**Return Value**:
- Returns AWS service client instance

**Usage Example**:
```python
import boto3

# Create S3 client using default session
s3 = boto3.client('s3', region_name='us-west-2')

# Create EC2 client
ec2 = boto3.client('ec2')
```

#### 111. resource() Function

**Function Description**: Module-level function to create an AWS service resource using the default session.

**Import Method**:
```python
import boto3
```

**Function Signature**:
```python
def resource(*args, **kwargs) -> ServiceResource
```

**Parameters**:
- `*args`: Positional arguments, first argument is service_name (str), e.g., 's3', 'dynamodb', 'sqs'
- `**kwargs`: Additional arguments passed to Session.resource() (region_name, api_version, config, etc.)

**Return Value**:
- Returns AWS service resource instance

**Usage Example**:
```python
import boto3

# Create S3 resource using default session
s3 = boto3.resource('s3', region_name='us-west-2')

# Create DynamoDB resource
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')
```

#### 112. TypeSerializer Class

**Function Description**: Serializer class for converting Python data types to DynamoDB format.

**Import Method**:
```python
from boto3.dynamodb.types import TypeSerializer
```

**Class Signature**:
```python
class TypeSerializer:
    """This class serializes Python data types to DynamoDB types."""
    
    def serialize(self, value) -> dict
    
    def _get_dynamodb_type(self, value) -> str
    
    def _is_null(self, value) -> bool
    
    def _is_boolean(self, value) -> bool
    
    def _is_number(self, value) -> bool
    
    def _is_string(self, value) -> bool
    
    def _is_binary(self, value) -> bool
    
    def _is_set(self, value) -> bool
    
    def _is_type_set(self, value, type_validator) -> bool
    
    def _is_map(self, value) -> bool
    
    def _is_listlike(self, value) -> bool
    
    def _serialize_null(self, value) -> bool
    
    def _serialize_bool(self, value) -> bool
    
    def _serialize_n(self, value) -> str
    
    def _serialize_s(self, value) -> str
    
    def _serialize_b(self, value) -> bytes
    
    def _serialize_ss(self, value) -> list
    
    def _serialize_ns(self, value) -> list
    
    def _serialize_bs(self, value) -> list
    
    def _serialize_l(self, value) -> list
    
    def _serialize_m(self, value) -> dict
```

**Main Methods**:

**serialize()**: Serialize Python value to DynamoDB format
- `Parameters`:
  - `value`: Python value to serialize. Conversions: None → {'NULL': True}, True/False → {'BOOL': True/False}, int/Decimal → {'N': str(value)}, string → {'S': string}, Binary/bytearray/bytes → {'B': bytes}, set([int/Decimal]) → {'NS': [str(value)]}, set([string]) → {'SS': [string]}, set([Binary/bytearray/bytes]) → {'BS': [bytes]}, list → {'L': list}, dict → {'M': dict}
- `Returns`: dict - A dictionary that represents a DynamoDB data type. These dictionaries can be directly passed to botocore methods.
- `Note`: For types that involve numbers, it is recommended that Decimal objects are used to be able to round-trip the Python type. For types that involve binary, it is recommended that Binary objects are used to be able to round-trip the Python type.

**Internal Methods**:

**_get_dynamodb_type()**: Determine the DynamoDB type for a value
- `Parameters`: 
  - `value`: Value to check
- `Returns`: str - DynamoDB type code: 'NULL', 'BOOL', 'N', 'S', 'B', 'NS', 'SS', 'BS', 'M', 'L'

**Type Checking Methods**:
- **_is_null()**: Check if value is None
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_boolean()**: Check if value is boolean
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_number()**: Check if value is a number (int, Decimal). Raises TypeError for float types.
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_string()**: Check if value is a string
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_binary()**: Check if value is binary (Binary, bytearray, bytes)
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_set()**: Check if value is a set
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_type_set()**: Check if value is a set of specific type
  - `Parameters`: 
    - `value`: Value to check
    - `type_validator`: Function to validate each element type
  - `Returns`: bool
- **_is_map()**: Check if value is a mapping (dict)
  - `Parameters`: `value` - Value to check
  - `Returns`: bool
- **_is_listlike()**: Check if value is list-like (list, tuple)
  - `Parameters`: `value` - Value to check
  - `Returns`: bool

**Serialization Methods**:
- **_serialize_null()**: Returns True (for {'NULL': True})
  - `Parameters`: `value` - Value to serialize
  - `Returns`: bool
- **_serialize_bool()**: Returns the boolean value
  - `Parameters`: `value` - Value to serialize
  - `Returns`: bool
- **_serialize_n()**: Serialize number to string representation. Raises TypeError for Infinity and NaN.
  - `Parameters`: `value` - Value to serialize
  - `Returns`: str
- **_serialize_s()**: Returns the string value
  - `Parameters`: `value` - Value to serialize
  - `Returns`: str
- **_serialize_b()**: Extracts bytes from Binary or returns bytes/bytearray
  - `Parameters`: `value` - Value to serialize
  - `Returns`: bytes
- **_serialize_ss()**: Serialize string set to list of strings
  - `Parameters`: `value` - Value to serialize
  - `Returns`: list
- **_serialize_ns()**: Serialize number set to list of string representations
  - `Parameters`: `value` - Value to serialize
  - `Returns`: list
- **_serialize_bs()**: Serialize binary set to list of bytes
  - `Parameters`: `value` - Value to serialize
  - `Returns`: list
- **_serialize_l()**: Serialize list to list of serialized items
  - `Parameters`: `value` - Value to serialize
  - `Returns`: list
- **_serialize_m()**: Serialize dict/map to dict with serialized values
  - `Parameters`: `value` - Value to serialize
  - `Returns`: dict

**Usage Example**:
```python
from boto3.dynamodb.types import TypeSerializer, Binary

serializer = TypeSerializer()

# Serialize different types
print(serializer.serialize('hello'))  # {'S': 'hello'}
print(serializer.serialize(42))  # {'N': '42'}
print(serializer.serialize(['a', 'b']))  # {'L': [{'S': 'a'}, {'S': 'b'}]}
print(serializer.serialize({'key': 'value'}))  # {'M': {'key': {'S': 'value'}}}
print(serializer.serialize(Binary(b'data')))  # {'B': b'data'}
```

#### 113. TypeDeserializer Class

**Function Description**: Deserializer class for converting DynamoDB format data to Python types.

**Import Method**:
```python
from boto3.dynamodb.types import TypeDeserializer
```

**Class Signature**:
```python
class TypeDeserializer:
    """This class deserializes DynamoDB types to Python types."""
    
    def deserialize(self, value)
    
    def _deserialize_null(self, value) -> None
    
    def _deserialize_bool(self, value) -> bool
    
    def _deserialize_n(self, value) -> Decimal
    
    def _deserialize_s(self, value) -> str
    
    def _deserialize_b(self, value) -> Binary
    
    def _deserialize_ns(self, value) -> set
    
    def _deserialize_ss(self, value) -> set
    
    def _deserialize_bs(self, value) -> set
    
    def _deserialize_l(self, value) -> list
    
    def _deserialize_m(self, value) -> dict
```

**Main Methods**:

**deserialize()**: Deserialize DynamoDB formatted value to Python type
- `Parameters`:
  - `value` (dict): A DynamoDB value to be deserialized to a pythonic value. Must be a nonempty dictionary whose key is a valid DynamoDB type. Conversions: {'NULL': True} → None, {'BOOL': True/False} → True/False, {'N': str(value)} → Decimal(str(value)), {'S': string} → string, {'B': bytes} → Binary(bytes), {'NS': [str(value)]} → set([Decimal(str(value))]), {'SS': [string]} → set([string]), {'BS': [bytes]} → set([bytes]), {'L': list} → list, {'M': dict} → dict
- `Returns`: The pythonic value of the DynamoDB type
- `Note`: Raises TypeError if value is empty or if the DynamoDB type is not supported

**Internal Deserialization Methods**:
- **_deserialize_null()**: Returns None
  - `Parameters`: `value` - Value to deserialize (True)
  - `Returns`: None
- **_deserialize_bool()**: Returns the boolean value
  - `Parameters`: `value` - Value to deserialize (bool)
  - `Returns`: bool
- **_deserialize_n()**: Deserialize number string to Decimal
  - `Parameters`: `value` - Value to deserialize (str)
  - `Returns`: Decimal
- **_deserialize_s()**: Returns the string value
  - `Parameters`: `value` - Value to deserialize (str)
  - `Returns`: str
- **_deserialize_b()**: Deserialize bytes to Binary object
  - `Parameters`: `value` - Value to deserialize (bytes)
  - `Returns`: Binary
- **_deserialize_ns()**: Deserialize number set to set of Decimal
  - `Parameters`: `value` - Value to deserialize (list of str)
  - `Returns`: set - Set of Decimal objects
- **_deserialize_ss()**: Deserialize string set to set of str
  - `Parameters`: `value` - Value to deserialize (list of str)
  - `Returns`: set - Set of strings
- **_deserialize_bs()**: Deserialize binary set to set of Binary
  - `Parameters`: `value` - Value to deserialize (list of bytes)
  - `Returns`: set - Set of Binary objects
- **_deserialize_l()**: Deserialize list to list of deserialized items
  - `Parameters`: `value` - Value to deserialize (list)
  - `Returns`: list
- **_deserialize_m()**: Deserialize map to dict with deserialized values
  - `Parameters`: `value` - Value to deserialize (dict)
  - `Returns`: dict

**Usage Example**:
```python
from boto3.dynamodb.types import TypeDeserializer

deserializer = TypeDeserializer()

# Deserialize different types
print(deserializer.deserialize({'S': 'hello'}))  # 'hello'
print(deserializer.deserialize({'N': '42'}))  # Decimal('42')
print(deserializer.deserialize({'L': [{'S': 'a'}]}))  # ['a']
print(deserializer.deserialize({'M': {'k': {'S': 'v'}}}))  # {'k': 'v'}
print(deserializer.deserialize({'BOOL': True}))  # True
print(deserializer.deserialize({'B': b'data'}))  # Binary(b'data')
print(deserializer.deserialize({'NULL': True}))  # None
```

#### 114. ConditionExpressionBuilder Class

**Function Description**: Builder class for constructing DynamoDB condition expressions with placeholders.

**Import Method**:
```python
from boto3.dynamodb.conditions import ConditionExpressionBuilder
```

**Class Signature**:
```python
class ConditionExpressionBuilder:
    """This class is used to build condition expressions with placeholders"""
    
    def __init__(self) -> None
    
    def _get_name_placeholder(self) -> str
    
    def _get_value_placeholder(self) -> str
    
    def reset(self) -> None
    
    def build_expression(self, condition, is_key_condition=False) -> BuiltConditionExpression
    
    def _build_expression(
        self,
        condition,
        attribute_name_placeholders,
        attribute_value_placeholders,
        is_key_condition
    ) -> str
    
    def _build_expression_component(
        self,
        value,
        attribute_name_placeholders,
        attribute_value_placeholders,
        has_grouped_values,
        is_key_condition
    ) -> str
    
    def _build_name_placeholder(self, value, attribute_name_placeholders) -> str
    
    def _build_value_placeholder(
        self,
        value,
        attribute_value_placeholders,
        has_grouped_values=False
    ) -> str
```

**Parameters** (__init__ parameters):
- None (no parameters required)

**Instance Attributes** (set during initialization):
- `_name_count` (int): Counter for name placeholders, initialized to 0
- `_value_count` (int): Counter for value placeholders, initialized to 0
- `_name_placeholder` (str): Prefix for name placeholders, value: 'n'
- `_value_placeholder` (str): Prefix for value placeholders, value: 'v'

**Main Methods**:

**reset()**: Reset the builder's internal counters
- `Parameters`: None
- `Returns`: None
- `Note`: Resets the placeholder name and values counters to 0

**build_expression()**: Build condition expression with placeholders
- `Parameters`:
  - `condition` (ConditionBase): A condition to be built into a condition expression string with any necessary placeholders
  - `is_key_condition` (Boolean, optional): True if the expression is for a KeyConditionExpression. False otherwise. Default: False
- `Returns`: BuiltConditionExpression - Object containing condition_expression (string), attribute_name_placeholders (dict), and attribute_value_placeholders (dict). Example: ('#n0 = :v0', {'#n0': 'myattribute'}, {':v0': 'myvalue'})
- `Note`: Raises DynamoDBNeedsConditionError if condition is not a ConditionBase instance

**Internal Methods**:

**_get_name_placeholder()**: Generate next attribute name placeholder
- `Parameters`: None
- `Returns`: str - Placeholder in format '#n{count}' (e.g., '#n0', '#n1')

**_get_value_placeholder()**: Generate next attribute value placeholder
- `Parameters`: None
- `Returns`: str - Placeholder in format ':v{count}' (e.g., ':v0', ':v1')

**_build_expression()**: Recursively build condition expression string
- `Parameters`:
  - `condition` (ConditionBase): Condition object to build
  - `attribute_name_placeholders` (dict): Dictionary to store attribute name placeholders
  - `attribute_value_placeholders` (dict): Dictionary to store attribute value placeholders
  - `is_key_condition` (bool): Whether building key condition
- `Returns`: str - Expression string with placeholders

**_build_expression_component()**: Build a single component of expression
- `Parameters`:
  - `value`: Value to process (can be ConditionBase, AttributeBase, or literal value)
  - `attribute_name_placeholders` (dict): Dictionary to store attribute name placeholders
  - `attribute_value_placeholders` (dict): Dictionary to store attribute value placeholders
  - `has_grouped_values` (bool): Whether the value is grouped (e.g., for IN operator)
  - `is_key_condition` (bool): Whether building key condition
- `Returns`: str - Expression component string
- `Note`: Raises DynamoDBNeedsKeyConditionError if non-Key attribute is used in key condition

**_build_name_placeholder()**: Build and register attribute name placeholder
- `Parameters`:
  - `value` (AttributeBase): Attribute object
  - `attribute_name_placeholders` (dict): Dictionary to store placeholders
- `Returns`: str - Placeholder string with registered name parts

**_build_value_placeholder()**: Build and register attribute value placeholder
- `Parameters`:
  - `value`: Attribute value or list of values
  - `attribute_value_placeholders` (dict): Dictionary to store placeholders
  - `has_grouped_values` (bool, optional): If True, treats value as list and creates multiple placeholders. Default: False
- `Returns`: str - Placeholder string (single placeholder or grouped placeholders like '(:v0, :v1)')

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr, ConditionExpressionBuilder

builder = ConditionExpressionBuilder()
condition = Attr('age').gt(25) & Attr('city').eq('NYC')

# Build expression
result = builder.build_expression(condition)
print(result.condition_expression)  # '#n0 > :v0 AND #n1 = :v1'
print(result.attribute_name_placeholders)  # {'#n0': 'age', '#n1': 'city'}
print(result.attribute_value_placeholders)  # {':v0': 25, ':v1': 'NYC'}

# Reset counters for reuse
builder.reset()
```

#### 115. ResourceFactory Class

**Function Description**: Factory class for dynamically creating resource classes from JSON definitions.

**Import Method**:
```python
from boto3.resources.factory import ResourceFactory
```

**Class Signature**:
```python
class ResourceFactory:
    """
    A factory to create new :py:class:`~boto3.resources.base.ServiceResource`
    classes from a :py:class:`~boto3.resources.model.ResourceModel`. There are
    two types of lookups that can be done: one on the service itself (e.g. an
    SQS resource) and another on models contained within the service (e.g. an
    SQS Queue resource).
    """
    
    def __init__(self, emitter) -> None
    
    def load_from_definition(
        self,
        resource_name,
        single_resource_json_definition,
        service_context
    ) -> type
    
    def _load_identifiers(self, attrs, meta, resource_model, resource_name) -> None
    
    def _load_actions(self, attrs, resource_name, resource_model, service_context) -> None
    
    def _load_attributes(self, attrs, meta, resource_name, resource_model, service_context) -> None
    
    def _load_collections(self, attrs, resource_model, service_context) -> None
    
    def _load_has_relations(self, attrs, resource_name, resource_model, service_context) -> None
    
    def _create_available_subresources_command(self, attrs, subresources) -> None
    
    def _load_waiters(self, attrs, resource_name, resource_model, service_context) -> None
    
    def _create_identifier(factory_self, identifier, resource_name) -> property
    
    def _create_identifier_alias(
        factory_self,
        resource_name,
        identifier,
        member_model,
        service_context
    ) -> property
    
    def _create_autoload_property(
        factory_self,
        resource_name,
        name,
        snake_cased,
        member_model,
        service_context
    ) -> property
    
    def _create_waiter(
        factory_self,
        resource_waiter_model,
        resource_name,
        service_context
    ) -> callable
    
    def _create_collection(
        factory_self,
        resource_name,
        collection_model,
        service_context
    ) -> property
    
    def _create_reference(
        factory_self,
        reference_model,
        resource_name,
        service_context
    ) -> property
    
    def _create_class_partial(
        factory_self,
        subresource_model,
        resource_name,
        service_context
    ) -> callable
    
    def _create_action(
        factory_self,
        action_model,
        resource_name,
        service_context,
        is_load=False
    ) -> callable
```

**Parameters** (__init__ parameters):
- `emitter`: Event emitter for resource lifecycle events

**Instance Attributes** (set during initialization):
- `_collection_factory` (CollectionFactory): Factory instance for creating collections
- `_emitter`: Event emitter for resource events

**Main Methods**:

**load_from_definition()**: Load and create a resource class from JSON definition
- `Parameters`:
  - `resource_name` (str): Name of the resource to look up. For services, this should match the service_name
  - `single_resource_json_definition` (dict): The loaded json of a single service resource or resource definition
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: type - Subclass of ServiceResource. The service or resource class, e.g. EC2.Instance
- `Note`: Creates a new ServiceResource subclass with correct properties and methods, named based on the service and resource name

**Internal Methods**:

**_load_identifiers()**: Populate required identifiers into resource class
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `meta` (ResourceMeta): Metadata object for the resource
  - `resource_model` (ResourceModel): Model defining the resource
  - `resource_name` (str): Name of the resource
- `Returns`: None
- `Note`: Identifiers are arguments without which the resource cannot be used. They become arguments for operations on the resource.

**_load_actions()**: Load action methods into resource class
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `resource_name` (str): Name of the resource
  - `resource_model` (ResourceModel): Model defining the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: None
- `Note`: Actions on the resource become methods, with the load method being a special case which sets internal data for attributes, and reload is an alias for load.

**_load_attributes()**: Load attribute properties into resource class
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `meta` (ResourceMeta): Metadata object for the resource
  - `resource_name` (str): Name of the resource
  - `resource_model` (ResourceModel): Model defining the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: None
- `Note`: Load resource attributes based on the resource shape. The shape name is referenced in the resource JSON, but the shape itself is defined in the Botocore service JSON.

**_load_collections()**: Load collection properties into resource class
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `resource_model` (ResourceModel): Model defining the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: None
- `Note`: Each collection becomes a CollectionManager instance on the resource instance, which allows you to iterate and filter through the collection's items.

**_load_has_relations()**: Load relationship/reference properties into resource class
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `resource_name` (str): Name of the resource
  - `resource_model` (ResourceModel): Model defining the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: None
- `Note`: Load related resources via 'has' relationship: references (related resource instance that can be None) and subresources (resource constructor that always returns instance).

**_create_available_subresources_command()**: Create method listing available sub-resources
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `subresources` (list): List of subresource models
- `Returns`: None
- `Note`: Adds get_available_subresources() method that returns a list of all available sub-resource names

**_load_waiters()**: Load waiter methods into resource class
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `resource_name` (str): Name of the resource
  - `resource_model` (ResourceModel): Model defining the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: None
- `Note`: Each waiter allows you to wait until a resource reaches a specific state by polling the state of the resource.

**_create_identifier()**: Create read-only property for identifier attributes
- `Parameters`:
  - `factory_self`: Factory instance (uses factory_self instead of self)
  - `identifier`: Identifier model
  - `resource_name` (str): Name of the resource
- `Returns`: property

**_create_identifier_alias()**: Create read-only property that aliases an identifier
- `Parameters`:
  - `factory_self`: Factory instance
  - `resource_name` (str): Name of the resource
  - `identifier`: Identifier model
  - `member_model`: Member model from shape
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: property

**_create_autoload_property()**: Create lazy-load property via resource's load method
- `Parameters`:
  - `factory_self`: Factory instance
  - `resource_name` (str): Name of the resource
  - `name` (str): Original attribute name
  - `snake_cased` (str): Snake-cased attribute name
  - `member_model`: Member model from shape
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: property
- `Note`: Property loader checks if resource is loaded and returns cached value if possible. If not loaded, calls load() before returning value.

**_create_waiter()**: Create wait method for resource
- `Parameters`:
  - `factory_self`: Factory instance
  - `resource_waiter_model`: Waiter model for the resource
  - `resource_name` (str): Name of the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: callable
- `Note`: Creates a new wait method for each resource where both a waiter and resource model is defined

**_create_collection()**: Create lazy-load property for collection
- `Parameters`:
  - `factory_self`: Factory instance
  - `resource_name` (str): Name of the resource
  - `collection_model`: Collection model
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: property

**_create_reference()**: Create lazy-load property for reference
- `Parameters`:
  - `factory_self`: Factory instance
  - `reference_model`: Reference model
  - `resource_name` (str): Name of the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: property
- `Note`: References are essentially an action with no request or response, using response handlers to build resources from identifiers and data members.

**_create_class_partial()**: Create factory method for sub-resources
- `Parameters`:
  - `factory_self`: Factory instance
  - `subresource_model`: Subresource model
  - `resource_name` (str): Name of the resource
  - `service_context` (ServiceContext): Context about the AWS service
- `Returns`: callable
- `Note`: Creates method that acts as functools.partial, passing along the instance's low-level client to the new resource class' constructor

**_create_action()**: Create method that makes request to AWS service
- `Parameters`:
  - `factory_self`: Factory instance
  - `action_model`: Action model
  - `resource_name` (str): Name of the resource
  - `service_context` (ServiceContext): Context about the AWS service
  - `is_load` (bool, optional): Whether this is a load action. Default: False
- `Returns`: callable
- `Note`: A resource's load method is special because it sets values on the resource instead of returning the response

**Usage Example**:
```python
from boto3.resources.factory import ResourceFactory
from boto3.session import Session

session = Session()
factory = ResourceFactory(session.events)

# Load resource from definition
resource_class = factory.load_from_definition(
    'Bucket',
    resource_definition,
    service_context
)
```

#### 116. _warn_deprecated_python() Function

**Function Description**: Internal function to warn about deprecated Python versions.

**Import Method**:
```python
from boto3.compat import _warn_deprecated_python
```

**Function Signature**:
```python
def _warn_deprecated_python() -> None
```

**Parameters**:
- None

**Return Value**:
- Returns None (emits PythonDeprecationWarning if needed)

**Usage Example**:
```python
from boto3.compat import _warn_deprecated_python

# This is called internally on import to warn about Python version
_warn_deprecated_python()
```

#### 117. _get_default_session() Function

**Function Description**: Internal function to get or create the default boto3 session.

**Import Method**:
```python
from boto3 import _get_default_session
```

**Function Signature**:
```python
def _get_default_session() -> Session
```

**Parameters**:
- None

**Return Value**:
- Returns the default Session instance

**Usage Example**:
```python
from boto3 import _get_default_session

# Get the default session
session = _get_default_session()
print(session.region_name)
```

#### 118. _create_crt_client() Function

**Function Description**: Internal function to create a CRT client with proper configuration.

**Import Method**:
```python
from boto3.crt import _create_crt_client
```

**Function Signature**:
```python
def _create_crt_client(
    session,
    config,
    region_name,
    cred_provider
) -> CRTS3Client
```

**Parameters**:
- `session`: Boto3 session instance
- `config` (TransferConfig): Transfer configuration
- `region_name` (str): AWS region name
- `cred_provider`: CRT credentials provider

**Return Value**:
- Returns CRTS3Client instance

**Usage Example**:
```python
# Internal function used by get_crt_s3_client()
# Not typically called directly by users
```

#### 119. _create_crt_request_serializer() Function

**Function Description**: Internal function to create a CRT request serializer.

**Import Method**:
```python
from boto3.crt import _create_crt_request_serializer
```

**Function Signature**:
```python
def _create_crt_request_serializer(session, region_name)
```

**Parameters**:
- `session`: Boto3 session instance
- `region_name` (str): AWS region name

**Return Value**:
- Returns CRT request serializer instance

**Usage Example**:
```python
# Internal function for CRT request serialization
# Not typically called directly by users
```

#### 120. _create_crt_s3_client() Function

**Function Description**: Internal function to create the actual CRT S3 client instance.

**Import Method**:
```python
from boto3.crt import _create_crt_s3_client
```

**Function Signature**:
```python
def _create_crt_s3_client(
    session,
    config,
    region_name,
    credentials,
    lock
) -> awscrt.s3.S3Client
```

**Parameters**:
- `session`: Boto3 session instance
- `config` (TransferConfig): Transfer configuration
- `region_name` (str): AWS region name
- `credentials`: AWS credentials
- `lock`: Threading lock for synchronization

**Return Value**:
- Returns awscrt.s3.S3Client instance

**Usage Example**:
```python
# Internal function for creating CRT S3 client
# Not typically called directly by users
```

#### 121. _initialize_crt_transfer_primatives() Function

**Function Description**: Internal function to initialize CRT transfer primitives (client, serializer, etc.).

**Import Method**:
```python
from boto3.crt import _initialize_crt_transfer_primatives
```

**Function Signature**:
```python
def _initialize_crt_transfer_primatives(client, config) -> tuple
```

**Parameters**:
- `client`: Boto3 S3 client instance
- `config` (TransferConfig): Transfer configuration

**Return Value**:
- Returns tuple of (crt_s3_client, crt_request_serializer)

**Usage Example**:
```python
# Internal function to set up CRT transfer components
# Not typically called directly by users
```

#### 122. _should_use_crt() Function

**Function Description**: Internal function to determine if CRT should be used for transfers.

**Import Method**:
```python
from boto3.s3.transfer import _should_use_crt
```

**Function Signature**:
```python
def _should_use_crt(config) -> bool
```

**Parameters**:
- `config` (TransferConfig): Transfer configuration to check

**Return Value**:
- Returns True if CRT should be used based on config, False otherwise

**Usage Example**:
```python
from boto3.s3.transfer import _should_use_crt, TransferConfig

config = TransferConfig(preferred_transfer_client='crt')
should_use = _should_use_crt(config)
print(should_use)  # True if CRT is available

config_classic = TransferConfig(preferred_transfer_client='classic')
should_use = _should_use_crt(config_classic)
print(should_use)  # False
```

#### 123. _create_default_transfer_manager() Function

**Function Description**: Internal function to create the default (non-CRT) transfer manager.

**Import Method**:
```python
from boto3.s3.transfer import _create_default_transfer_manager
```

**Function Signature**:
```python
def _create_default_transfer_manager(
    client,
    config=None,
    osutil=None
) -> TransferManager
```

**Parameters**:
- `client`: Boto3 S3 client instance
- `config` (TransferConfig): Optional transfer configuration (default: None)
- `osutil`: Optional OS utility object (default: None)

**Return Value**:
- Returns s3transfer.manager.TransferManager instance

**Usage Example**:
```python
from boto3.s3.transfer import _create_default_transfer_manager
import boto3

s3_client = boto3.client('s3')

# Create default transfer manager
transfer_manager = _create_default_transfer_manager(s3_client)
```

#### 124. _method_returns_resource_list() Function

**Function Description**: Internal function to check if a method returns a list of resources.

**Import Method**:
```python
from boto3.docs.method import _method_returns_resource_list
```

**Function Signature**:
```python
def _method_returns_resource_list(resource) -> bool
```

**Parameters**:
- `resource`: Resource object or model to check

**Return Value**:
- Returns True if method returns a list of resources, False otherwise

**Usage Example**:
```python
# Internal function used during documentation generation
# to determine if method output should be documented as a list
```

### Constants

#### 125. DEFAULT_SESSION

**Function Description**: Global variable storing the default boto3 session instance.

**Import Method**:
```python
from boto3 import DEFAULT_SESSION
```

**Value**: Session instance or None

**Usage Example**:
```python
import boto3

# Setup default session first
boto3.setup_default_session(region_name='us-west-2')

# Access default session
print(boto3.DEFAULT_SESSION)
print(boto3.DEFAULT_SESSION.region_name)  # 'us-west-2'
```

#### 126. KB

**Function Description**: Kilobyte constant for transfer size calculations (1024 bytes).

**Import Method**:
```python
from boto3.s3.transfer import KB
```

**Value**: 1024

**Usage Example**:
```python
from boto3.s3.transfer import KB, TransferConfig

config = TransferConfig(
    io_chunksize=256 * KB  # 256 KB
)
```

#### 127. MB

**Function Description**: Megabyte constant for transfer size calculations (1024 * 1024 bytes).

**Import Method**:
```python
from boto3.s3.transfer import MB
```

**Value**: 1048576 (1024 * 1024)

**Usage Example**:
```python
from boto3.s3.transfer import MB, TransferConfig

config = TransferConfig(
    multipart_threshold=8 * MB,  # 8 MB
    multipart_chunksize=16 * MB  # 16 MB
)
```

#### 128. AUTO_RESOLVE_TRANSFER_CLIENT

**Function Description**: Constant for automatically resolving transfer client type (CRT or classic).

**Import Method**:
```python
from boto3.s3.constants import AUTO_RESOLVE_TRANSFER_CLIENT
```

**Value**: 'auto'

**Usage Example**:
```python
from boto3.s3.constants import AUTO_RESOLVE_TRANSFER_CLIENT
from boto3.s3.transfer import TransferConfig

config = TransferConfig(
    preferred_transfer_client=AUTO_RESOLVE_TRANSFER_CLIENT
)
# Will automatically choose CRT if available, otherwise classic
```

#### 129. CLASSIC_TRANSFER_CLIENT

**Function Description**: Constant for specifying classic (non-CRT) transfer client.

**Import Method**:
```python
from boto3.s3.constants import CLASSIC_TRANSFER_CLIENT
```

**Value**: 'classic'

**Usage Example**:
```python
from boto3.s3.constants import CLASSIC_TRANSFER_CLIENT
from boto3.s3.transfer import TransferConfig

config = TransferConfig(
    preferred_transfer_client=CLASSIC_TRANSFER_CLIENT
)
# Forces use of classic transfer manager
```

#### 130. PUT_DATA_WARNING_MESSAGE

**Function Description**: Warning message for PUT operations that may modify data.

**Import Method**:
```python
from boto3.docs.action import PUT_DATA_WARNING_MESSAGE
```

**Value**: String containing warning about PUT data operations

**Usage Example**:
```python
from boto3.docs.action import PUT_DATA_WARNING_MESSAGE

# Used in documentation generation
print(PUT_DATA_WARNING_MESSAGE)
# "This method may not be supported by all services."
```

#### 131. STRING

**Function Description**: DynamoDB type constant for string data type.

**Import Method**:
```python
from boto3.dynamodb.types import STRING
```

**Value**: 'S'

**Usage Example**:
```python
from boto3.dynamodb.types import STRING

# Used in type serialization/deserialization
dynamodb_value = {STRING: 'hello world'}  # {'S': 'hello world'}
```

#### 132. NUMBER

**Function Description**: DynamoDB type constant for number data type.

**Import Method**:
```python
from boto3.dynamodb.types import NUMBER
```

**Value**: 'N'

**Usage Example**:
```python
from boto3.dynamodb.types import NUMBER

# Used in type serialization/deserialization
dynamodb_value = {NUMBER: '42'}  # {'N': '42'}
```

#### 133. BINARY

**Function Description**: DynamoDB type constant for binary data type.

**Import Method**:
```python
from boto3.dynamodb.types import BINARY
```

**Value**: 'B'

**Usage Example**:
```python
from boto3.dynamodb.types import BINARY

# Used in type serialization/deserialization
dynamodb_value = {BINARY: b'\x00\x01'}  # {'B': b'\x00\x01'}
```

#### 134. STRING_SET

**Function Description**: DynamoDB type constant for string set data type.

**Import Method**:
```python
from boto3.dynamodb.types import STRING_SET
```

**Value**: 'SS'

**Usage Example**:
```python
from boto3.dynamodb.types import STRING_SET

# Used in type serialization/deserialization
dynamodb_value = {STRING_SET: ['a', 'b', 'c']}  # {'SS': ['a', 'b', 'c']}
```

#### 135. NUMBER_SET

**Function Description**: DynamoDB type constant for number set data type.

**Import Method**:
```python
from boto3.dynamodb.types import NUMBER_SET
```

**Value**: 'NS'

**Usage Example**:
```python
from boto3.dynamodb.types import NUMBER_SET

# Used in type serialization/deserialization
dynamodb_value = {NUMBER_SET: ['1', '2', '3']}  # {'NS': ['1', '2', '3']}
```

#### 136. BINARY_SET

**Function Description**: DynamoDB type constant for binary set data type.

**Import Method**:
```python
from boto3.dynamodb.types import BINARY_SET
```

**Value**: 'BS'

**Usage Example**:
```python
from boto3.dynamodb.types import BINARY_SET

# Used in type serialization/deserialization
dynamodb_value = {BINARY_SET: [b'\x00', b'\x01']}  # {'BS': [b'\x00', b'\x01']}
```

#### 137. NULL

**Function Description**: DynamoDB type constant for null data type.

**Import Method**:
```python
from boto3.dynamodb.types import NULL
```

**Value**: 'NULL'

**Usage Example**:
```python
from boto3.dynamodb.types import NULL

# Used in type serialization/deserialization
dynamodb_value = {NULL: True}  # {'NULL': True}
```

#### 138. BOOLEAN

**Function Description**: DynamoDB type constant for boolean data type.

**Import Method**:
```python
from boto3.dynamodb.types import BOOLEAN
```

**Value**: 'BOOL'

**Usage Example**:
```python
from boto3.dynamodb.types import BOOLEAN

# Used in type serialization/deserialization
dynamodb_value = {BOOLEAN: True}  # {'BOOL': True}
```

#### 139. MAP

**Function Description**: DynamoDB type constant for map (dictionary) data type.

**Import Method**:
```python
from boto3.dynamodb.types import MAP
```

**Value**: 'M'

**Usage Example**:
```python
from boto3.dynamodb.types import MAP

# Used in type serialization/deserialization
dynamodb_value = {MAP: {'key': {'S': 'value'}}}  # {'M': {'key': {'S': 'value'}}}
```

#### 140. LIST

**Function Description**: DynamoDB type constant for list data type.

**Import Method**:
```python
from boto3.dynamodb.types import LIST
```

**Value**: 'L'

**Usage Example**:
```python
from boto3.dynamodb.types import LIST

# Used in type serialization/deserialization
dynamodb_value = {LIST: [{'S': 'a'}, {'N': '1'}]}  # {'L': [{'S': 'a'}, {'N': '1'}]}
```

### Type Aliases

#### 141. __version__

**Function Description**: Package version string type alias.

**Import Method**:
```python
from boto3 import __version__
```

**Value**: String representing current boto3 version (e.g., '1.40.56')

**Usage Example**:
```python
import boto3

# Get boto3 version
version = boto3.__version__
print(f"Using boto3 version: {version}")
```

#### 142. __author__

**Function Description**: Package author information type alias.

**Import Method**:
```python
from boto3 import __author__
```

**Value**: 'Amazon Web Services'

**Usage Example**:
```python
import boto3

# Get author info
author = boto3.__author__
print(f"Author: {author}")  # 'Amazon Web Services'
```

#### 143. BuiltConditionExpression

**Function Description**: Named tuple type alias for built DynamoDB condition expressions.

**Import Method**:
```python
from boto3.dynamodb.conditions import BuiltConditionExpression
```

**Type Definition**:
```python
BuiltConditionExpression = namedtuple(
    'BuiltConditionExpression',
    ['condition_expression', 'attribute_name_placeholders', 'attribute_value_placeholders']
)
```

**Fields**:
- `condition_expression` (str): The built expression string
- `attribute_name_placeholders` (dict): Name placeholder mapping
- `attribute_value_placeholders` (dict): Value placeholder mapping

**Usage Example**:
```python
from boto3.dynamodb.conditions import ConditionExpressionBuilder, Attr

builder = ConditionExpressionBuilder()
condition = Attr('age').gt(25)

# Build returns a BuiltConditionExpression
expression, names, values = builder.build_expression(condition)
# expression: '#n0 > :v0'
# names: {'#n0': 'age'}
# values: {':v0': 25}
```

#### 144. ROOT

**Function Description**: Root directory path constant in setup.py.

**Location**: `setup.py` (line 12) - **Not importable by end users**

**Value**: 
```python
ROOT = os.path.dirname(__file__)
```

**Note**: This constant exists only in setup.py and cannot be imported. It's used to locate package files during installation.

**Usage Example**:
```python
# Used internally in setup.py
# ROOT = os.path.dirname(__file__)
# path = os.path.join(ROOT, 'boto3', '__init__.py')
```

#### 145. VERSION_RE

**Function Description**: Regular expression pattern for version string extraction in setup.py.

**Location**: `setup.py` (line 13) - **Not importable by end users**

**Value**: 
```python
VERSION_RE = re.compile(r'''__version__ = ['"]([0-9.]+)['"]''')
```

**Note**: This constant exists only in setup.py and cannot be imported. It's used by get_version() to extract version from `__init__.py`.

**Usage Example**:
```python
# Used internally in setup.py
# VERSION_RE.search(init_file_content).group(1)
```

#### 146. SOCKET_ERROR

**Function Description**: Socket error exception type for network operations.

**Import Method**:
```python
from boto3.compat import SOCKET_ERROR
```

**Value**: Exception class for socket errors

**Usage Example**:
```python
from boto3.compat import SOCKET_ERROR

try:
    # Network operation
    pass
except SOCKET_ERROR as e:
    print(f"Socket error: {e}")
```

#### 147. _APPEND_MODE_CHAR

**Function Description**: Character constant representing append mode in file operations.

**Import Method**:
```python
from boto3.compat import _APPEND_MODE_CHAR
```

**Value**: 'a'

**Usage Example**:
```python
# Used internally to check if file is in append mode
```

#### 148. CRT_S3_CLIENT

**Function Description**: Global variable storing the CRT S3 client instance.

**Import Method**:
```python
from boto3.crt import CRT_S3_CLIENT
```

**Value**: CRTS3Client instance or None

**Usage Example**:
```python
# Internal global variable for CRT client caching
```

#### 149. BOTOCORE_CRT_SERIALIZER

**Function Description**: Global variable storing the botocore CRT request serializer.

**Import Method**:
```python
from boto3.crt import BOTOCORE_CRT_SERIALIZER
```

**Value**: CRT request serializer instance or None

**Usage Example**:
```python
# Internal global variable for CRT serializer caching
```

#### 150. CLIENT_CREATION_LOCK

**Function Description**: Threading lock for thread-safe client creation.

**Import Method**:
```python
from boto3.crt import CLIENT_CREATION_LOCK
```

**Value**: threading.Lock instance

**Usage Example**:
```python
# Internal lock used to synchronize CRT client creation
```

#### 151. PROCESS_LOCK_NAME

**Function Description**: Name constant for process lock used in CRT operations.

**Import Method**:
```python
from boto3.crt import PROCESS_LOCK_NAME
```

**Value**: String containing the process lock name

**Usage Example**:
```python
# Used internally for process-level locking in CRT transfers
```

#### 152. INDEX_RE

**Function Description**: Regular expression pattern for parsing array indices in parameter paths.

**Import Method**:
```python
from boto3.resources.params import INDEX_RE
```

**Value**: Compiled regex pattern for matching array indices (e.g., [0], [1])

**Usage Example**:
```python
# Used internally to parse parameter paths like 'Instances[0].InstanceId'
```

#### 153. DYNAMODB_CONTEXT

**Function Description**: Decimal Context object for DynamoDB number precision and range limits.

**Import Method**:
```python
from boto3.dynamodb.types import DYNAMODB_CONTEXT
```

**Value**: 
```python
DYNAMODB_CONTEXT = Context(
    Emin=-128,
    Emax=126,
    prec=38,
    traps=[Clamped, Overflow, Inexact, Rounded, Underflow],
)
```

**Note**: This Context from Python's decimal module defines the precision (38 digits) and exponent range for DynamoDB numbers.

**Usage Example**:
```python
from boto3.dynamodb.types import DYNAMODB_CONTEXT
from decimal import Decimal

# Used internally for DynamoDB number serialization
# Numbers are validated against this context
```

#### 154. BINARY_TYPES

**Function Description**: Tuple of binary type classes for type checking.

**Import Method**:
```python
from boto3.dynamodb.types import BINARY_TYPES
```

**Value**: 
```python
BINARY_TYPES = (bytearray, bytes)
```

**Note**: Used to validate binary data before wrapping in Binary class. Does NOT include Binary class itself.

**Usage Example**:
```python
from boto3.dynamodb.types import BINARY_TYPES

data = b'binary data'
if isinstance(data, BINARY_TYPES):
    print("This is binary data")

bytearray_data = bytearray(b'data')
if isinstance(bytearray_data, BINARY_TYPES):
    print("This is also binary data")
```

#### 155. ATTR_NAME_REGEX

**Function Description**: Regular expression pattern for validating DynamoDB attribute names.

**Import Method**:
```python
from boto3.dynamodb.conditions import ATTR_NAME_REGEX
```

**Value**: Compiled regex pattern for attribute name validation

**Usage Example**:
```python
# Used internally to validate attribute names in condition expressions
```

#### 156. WARNING_MESSAGES

**Function Description**: Dictionary of warning messages for documentation generation.

**Import Method**:
```python
from boto3.docs.action import WARNING_MESSAGES
```

**Value**: Dictionary mapping warning types to message strings

**Usage Example**:
```python
# Used internally in documentation generation for action warnings
```

#### 157. IGNORE_PARAMS

**Function Description**: List of parameter names to ignore in documentation.

**Import Method**:
```python
from boto3.docs.action import IGNORE_PARAMS
```

**Value**: List of parameter names that should not be documented

**Usage Example**:
```python
# Used internally to filter out internal parameters from documentation
```

#### 158. DynamoDBOperationNotSupportedError

**Function Description**: Exception raised when an operation is not supported for a DynamoDB attribute operand.

**Import Method**:
```python
from boto3.exceptions import DynamoDBOperationNotSupportedError
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class DynamoDBOperationNotSupportedError(Boto3Error):
    """Raised for operations that are not supported for an operand."""
    
    def __init__(self, operation, value) -> None
```

**Parameters** (__init__ parameters):
- `operation`: The operation that was attempted
- `value`: The value on which the operation was attempted

**Error Message Format**: 
"{operation} operation cannot be applied to value {value} of type {type(value)} directly. Must use AttributeBase object methods (i.e. Attr().eq()). to generate ConditionBase instances first."

**Note**: There is also a backward-compatibility alias `DynanmoDBOperationNotSupportedError` (with typo) in the source code, but you should use the correctly spelled `DynamoDBOperationNotSupportedError`.

**Usage Example**:
```python
from boto3.exceptions import DynamoDBOperationNotSupportedError
from boto3.dynamodb.conditions import Attr

try:
    # Attempting invalid operation on attribute
    result = Attr('age') & 25  # Cannot use & with non-condition
except DynamoDBOperationNotSupportedError as e:
    print(f"Operation not supported: {e}")
    # Output: "& operation cannot be applied to value 25 of type <class 'int'> 
    # directly. Must use AttributeBase object methods (i.e. Attr().eq()). 
    # to generate ConditionBase instances first."
```

---

#### 159. ServiceResource Class

**Function Description**: Base class for all AWS service resources, providing common functionality and metadata access.

**Import Method**:
```python
from boto3.resources.base import ServiceResource
```

**Parent Class**: None (base class)

**Class Signature**:
```python
class ServiceResource:
    """
    A base class for resources.
    
    :type client: botocore.client
    :param client: A low-level Botocore client instance
    """
    
    meta = None
    """
    Stores metadata about this resource instance, such as the
    ``service_name``, the low-level ``client`` and any cached ``data``
    from when the instance was hydrated. For example::
    
        # Get a low-level client from a resource instance
        client = resource.meta.client
        response = client.operation(Param='foo')
        
        # Print the resource instance's service short name
        print(resource.meta.service_name)
    
    See :py:class:`ResourceMeta` for more information.
    """
    
    def __init__(self, *args, **kwargs) -> None
    
    def __repr__(self) -> str
    
    def __eq__(self, other) -> bool
    
    def __hash__(self) -> int
```

**Parameters** (__init__ parameters):
- `*args`: Positional arguments for resource identifiers (in order defined in the ResourceJSON)
- `**kwargs`: Keyword arguments. Can include `client` (botocore.client) and identifier names with their values

**Class Attributes**:
- `meta` (ResourceMeta or None): Stores metadata about this resource instance, such as the service_name, the low-level client and any cached data from when the instance was hydrated. See ResourceMeta for more information.

**Main Methods**:

**__init__()**: Initialize resource with identifiers and optional client
- `Parameters`:
  - `*args`: Positional arguments for resource identifiers (in order defined)
  - `**kwargs`: Keyword arguments including 'client' and identifier names
- `Returns`: None
- `Note`: Creates a copy of meta, sets client (creates default if not provided), sets identifiers from args and kwargs, and validates that all required identifiers are provided. Raises ValueError if unknown keyword argument or required identifier not set.

**__repr__()**: String representation showing resource class name and identifiers
- `Parameters`: None
- `Returns`: str - Format: "ClassName(identifier1='value1', identifier2='value2')"

**__eq__()**: Compare resources by class name and identifier values
- `Parameters`: 
  - `other`: Another resource instance to compare with
- `Returns`: bool - True if same class and all identifiers have same values
- `Note`: Two resource instances are equal if they have the same class name and identical identifier values

**__hash__()**: Generate hash from class name and identifiers
- `Parameters`: None
- `Returns`: int - Hash value based on class name and tuple of identifier values
- `Note`: Allows resources to be used in sets and as dictionary keys

**Usage Example**:
```python
import boto3

# ServiceResource is the base class - use specific resources
s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')  # Bucket inherits from ServiceResource

# Access metadata
print(bucket.meta.service_name)  # 's3'
print(bucket.meta.client)  # Low-level client
print(bucket.meta.identifiers)  # ['name']

# String representation
print(repr(bucket))  # s3.Bucket(name='my-bucket')

# Equality comparison
bucket1 = s3.Bucket('my-bucket')
bucket2 = s3.Bucket('my-bucket')
bucket3 = s3.Bucket('other-bucket')
print(bucket1 == bucket2)  # True (same identifiers)
print(bucket1 == bucket3)  # False (different identifiers)

# Use in sets and as dict keys (hashable)
bucket_set = {bucket1, bucket2, bucket3}
print(len(bucket_set))  # 2 (bucket1 and bucket2 are same)
```

---

#### 160. ResourceMeta Class

**Function Description**: Container for resource metadata including service name, identifiers, client, and data.

**Import Method**:
```python
from boto3.resources.base import ResourceMeta
```

**Class Signature**:
```python
class ResourceMeta:
    """
    An object containing metadata about a resource.
    """
    
    def __init__(
        self,
        service_name,
        identifiers=None,
        client=None,
        data=None,
        resource_model=None
    ) -> None
    
    def __repr__(self) -> str
    
    def __eq__(self, other) -> bool
    
    def copy(self) -> ResourceMeta
```

**Parameters** (__init__ parameters):
- `service_name` (str): The service name, e.g. 's3'
- `identifiers` (list, optional): List of identifier names. Default: None (converted to [])
- `client` (BaseClient, optional): Low-level Botocore client. Default: None
- `data` (dict, optional): Loaded resource data attributes. Default: None
- `resource_model` (ResourceModel, optional): The resource model for that resource. Default: None

**Instance Attributes** (set during initialization):
- `service_name` (str): The service name, e.g. 's3'
- `identifiers` (list): List of identifier names
- `client` (BaseClient): Low-level Botocore client
- `data` (dict): Loaded resource data attributes
- `resource_model` (ResourceModel): The resource model for that resource

**Main Methods**:

**__repr__()**: String representation of the metadata
- `Parameters`: None
- `Returns`: str - Format: "ResourceMeta('service_name', identifiers=[...])"

**__eq__()**: Compare metadata objects for equality
- `Parameters`:
  - `other`: Another object to compare with
- `Returns`: bool - True if same class and all attributes are equal
- `Note`: Two metas are equal if their components are all equal (compares __dict__)

**copy()**: Create a copy of this metadata object
- `Parameters`: None
- `Returns`: ResourceMeta - A new ResourceMeta instance with copied attributes

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Access metadata
meta = bucket.meta
print(meta.service_name)  # 's3'
print(meta.identifiers)  # ['name']
print(meta.data)  # None (until loaded)

# Use client directly
response = meta.client.list_objects_v2(Bucket='my-bucket')

# String representation
print(repr(meta))  # ResourceMeta('s3', identifiers=['name'])

# Copy metadata
meta_copy = meta.copy()
print(meta == meta_copy)  # True (same attributes)
print(meta is meta_copy)  # False (different objects)

# Load data and check
bucket.load()
print(meta.data)  # {'Name': 'my-bucket', 'CreationDate': ...}
```

---

#### 161. TransformationInjector Class

**Function Description**: Injects type transformations and condition expressions into DynamoDB parameters.

**Import Method**:
```python
from boto3.dynamodb.transform import TransformationInjector
```

**Class Signature**:
```python
class TransformationInjector:
    """Injects the transformations into the user provided parameters."""
    
    def __init__(
        self,
        transformer=None,
        condition_builder=None,
        serializer=None,
        deserializer=None
    ) -> None
    
    def inject_condition_expressions(self, params, model, **kwargs) -> None
    
    def inject_attribute_value_input(self, params, model, **kwargs) -> None
    
    def inject_attribute_value_output(self, parsed, model, **kwargs) -> None
```

**Parameters** (__init__ parameters):
- `transformer` (ParameterTransformer, optional): Parameter transformer. Default: None (creates new ParameterTransformer instance)
- `condition_builder` (ConditionExpressionBuilder, optional): Condition expression builder. Default: None (creates new ConditionExpressionBuilder instance)
- `serializer` (TypeSerializer, optional): Type serializer for converting Python types to DynamoDB format. Default: None (creates new TypeSerializer instance)
- `deserializer` (TypeDeserializer, optional): Type deserializer for converting DynamoDB format to Python types. Default: None (creates new TypeDeserializer instance)

**Instance Attributes** (set during initialization):
- `_transformer` (ParameterTransformer): Parameter transformer instance
- `_condition_builder` (ConditionExpressionBuilder): Condition expression builder instance
- `_serializer` (TypeSerializer): Type serializer instance
- `_deserializer` (TypeDeserializer): Type deserializer instance

**Main Methods**:

**inject_condition_expressions()**: Injects the condition expression transformation into the parameters
- `Parameters`:
  - `params` (dict): Request parameters to be modified
  - `model`: Operation model with input_shape
  - `**kwargs`: Additional keyword arguments
- `Returns`: None
- `Note`: This injection includes transformations for ConditionExpression shapes and KeyExpression shapes. It also handles any placeholder names and values that are generated when transforming the condition expressions. Updates ExpressionAttributeNames and ExpressionAttributeValues in params.

**inject_attribute_value_input()**: Injects DynamoDB serialization into parameter input
- `Parameters`:
  - `params` (dict): Request parameters to be modified
  - `model`: Operation model with input_shape
  - `**kwargs`: Additional keyword arguments
- `Returns`: None
- `Note`: Transforms AttributeValue shapes in the input parameters using the serializer

**inject_attribute_value_output()**: Injects DynamoDB deserialization into responses
- `Parameters`:
  - `parsed`: Parsed response data to be modified
  - `model`: Operation model with output_shape
  - `**kwargs`: Additional keyword arguments
- `Returns`: None
- `Note`: Transforms AttributeValue shapes in the response using the deserializer. Only processes if model has output_shape.

**Usage Example**:
```python
# Note: This class is used internally by DynamoDB resources
# End users typically don't instantiate it directly
from boto3.dynamodb.transform import TransformationInjector

injector = TransformationInjector()
# Used automatically when making DynamoDB requests
```

---

#### 162. ParameterTransformer Class

**Function Description**: Transforms parameters to and from botocore based on shape definitions.

**Import Method**:
```python
from boto3.dynamodb.transform import ParameterTransformer
```

**Class Signature**:
```python
class ParameterTransformer:
    """Transforms the input to and output from botocore based on shape"""
    
    def transform(self, params, model, transformation, target_shape) -> None
    
    def _transform_parameters(self, model, params, transformation, target_shape) -> None
    
    def _transform_structure(self, model, params, transformation, target_shape) -> None
    
    def _transform_map(self, model, params, transformation, target_shape) -> None
    
    def _transform_list(self, model, params, transformation, target_shape) -> None
```

**Parameters** (__init__ parameters):
- None (no parameters required)

**Main Methods**:

**transform()**: Transforms the dynamodb input to or output from botocore
- `Parameters`:
  - `params`: The parameters structure to transform
  - `model`: The operation model
  - `transformation`: The function to apply the parameter
  - `target_shape` (str): The name of the shape to apply the transformation to
- `Returns`: None
- `Note`: It applies a specified transformation whenever a specific shape name is encountered while traversing the parameters in the dictionary.

**Internal Methods**:

**_transform_parameters()**: Transform parameters based on type
- `Parameters`:
  - `model`: Model to check type_name
  - `params`: Parameters to transform
  - `transformation`: Transformation function
  - `target_shape` (str): Target shape name
- `Returns`: None
- `Note`: Dispatches to _transform_structure, _transform_map, or _transform_list based on type_name

**_transform_structure()**: Transform structure type parameters
- `Parameters`:
  - `model`: Structure model with members
  - `params`: Parameters dictionary to transform
  - `transformation`: Transformation function
  - `target_shape` (str): Target shape name
- `Returns`: None
- `Note`: Recursively transforms members in the structure that match target_shape

**_transform_map()**: Transform map type parameters
- `Parameters`:
  - `model`: Map model with value model
  - `params`: Parameters dictionary to transform
  - `transformation`: Transformation function
  - `target_shape` (str): Target shape name
- `Returns`: None
- `Note`: Recursively transforms map values that match target_shape

**_transform_list()**: Transform list type parameters
- `Parameters`:
  - `model`: List model with member model
  - `params`: Parameters list to transform
  - `transformation`: Transformation function
  - `target_shape` (str): Target shape name
- `Returns`: None
- `Note`: Recursively transforms list items that match target_shape

**Usage Example**:
```python
# Note: Used internally by TransformationInjector
from boto3.dynamodb.transform import ParameterTransformer

transformer = ParameterTransformer()
# Applied automatically during DynamoDB operations
```

---

#### 163. DynamoDBHighLevelResource Class

**Function Description**: Base class for DynamoDB resources with automatic transformation injection.

**Import Method**:
```python
from boto3.dynamodb.transform import DynamoDBHighLevelResource
```

**Parent Class**: Dynamically determined (used as mixin)

**Class Signature**:
```python
class DynamoDBHighLevelResource:
    def __init__(self, *args, **kwargs) -> None
```

**Parameters** (__init__ parameters):
- `*args`: Variable positional arguments passed to parent class
- `**kwargs`: Variable keyword arguments passed to parent class

**Instance Attributes** (set during initialization):
- `_injector` (TransformationInjector): Transformation injector for condition expressions and type conversions

**Main Methods**:

**__init__()**: Initialize DynamoDB resource with transformation handlers
- `Parameters`:
  - `*args`: Positional arguments passed to parent class
  - `**kwargs`: Keyword arguments passed to parent class
- `Returns`: None
- `Note`: Registers multiple event handlers:
  1. 'provide-client-params.dynamodb' - copy_dynamodb_params (creates copy of user-provided DynamoDB item)
  2. 'before-parameter-build.dynamodb' - inject_condition_expressions (generates condition expressions with placeholders)
  3. 'before-parameter-build.dynamodb' - inject_attribute_value_input (serializes from Python types to DynamoDB types)
  4. 'after-call.dynamodb' - inject_attribute_value_output (deserializes from DynamoDB types to Python types)
  5. 'docs.*.dynamodb.*.complete-section' - Three documentation customizations for AttributeValue, KeyExpression, and ConditionExpression shapes

**Usage Example**:
```python
import boto3

# DynamoDB resources automatically use this class
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('my-table')  # Inherits from DynamoDBHighLevelResource

# Automatic transformations allow using Python types directly
from boto3.dynamodb.conditions import Key, Attr

response = table.query(
    KeyConditionExpression=Key('id').eq('123'),  # Auto-transformed
    FilterExpression=Attr('age').gt(25),  # Auto-transformed
)
```

---

#### 164. Action Class

**Function Description**: Model class representing a service operation action in resource definitions.

**Import Method**:
```python
from boto3.resources.model import Action
```

**Class Signature**:
```python
class Action:
    """
    A service operation action.
    
    :type name: string
    :param name: The name of the action
    :type definition: dict
    :param definition: The JSON definition
    :type resource_defs: dict
    :param resource_defs: All resources defined in the service
    """
    
    def __init__(self, name, definition, resource_defs) -> None
```

**Parameters** (__init__ parameters):
- `name` (str): The name of the action
- `definition` (dict): The JSON definition
- `resource_defs` (dict): All resources defined in the service

**Instance Attributes** (set during initialization):
- `_definition` (dict): Stored JSON definition (private)
- `name` (str): The name of the action
- `request` (Request or None): This action's request or None. Created from definition['request'] if present.
- `resource` (ResponseResource or None): This action's resource or None. Created from definition['resource'] if present.
- `path` (str or None): The JMESPath search path or None. Retrieved from definition.get('path').

**Usage Example**:
```python
# Note: Used internally by ResourceFactory
# Not typically instantiated by end users
from boto3.resources.model import Action

action = Action('load', action_definition, resource_defs)
```

---

#### 165. ResourceModel Class

**Function Description**: Model representing a resource defined via JSON description format.

**Import Method**:
```python
from boto3.resources.model import ResourceModel
```

**Class Signature**:
```python
class ResourceModel:
    """
    A model representing a resource, defined via a JSON description
    format. A resource has identifiers, attributes, actions,
    sub-resources, references and collections. For more information
    on resources, see :ref:`guide_resources`.
    
    :type name: string
    :param name: The name of this resource, e.g. ``sqs`` or ``Queue``
    :type definition: dict
    :param definition: The JSON definition
    :type resource_defs: dict
    :param resource_defs: All resources defined in the service
    """
    
    def __init__(self, name, definition, resource_defs) -> None
    
    def load_rename_map(self, shape=None) -> None
    
    def _load_name_with_category(self, names, name, category, snake_case=True) -> None
    
    def _get_name(self, category, name, snake_case=True) -> str
    
    def get_attributes(self, shape) -> dict
    
    @property
    def identifiers(self) -> list
    
    @property
    def load(self)
    
    @property
    def actions(self) -> list
    
    @property
    def batch_actions(self) -> list
    
    def _get_has_definition(self) -> dict
    
    def _get_related_resources(self, subresources) -> list
    
    @property
    def subresources(self) -> list
    
    @property
    def references(self) -> list
    
    @property
    def collections(self) -> list
    
    @property
    def waiters(self) -> list
```

**Parameters** (__init__ parameters):
- `name` (str): The name of this resource, e.g. 'sqs' or 'Queue'
- `definition` (dict): The JSON definition
- `resource_defs` (dict): All resources defined in the service

**Instance Attributes** (set during initialization):
- `_definition` (dict): Stored JSON definition (private)
- `_resource_defs` (dict): All resources defined in the service (private)
- `_renamed` (dict): Name translation map for collision handling (private)
- `name` (str): The name of this resource
- `shape` (str or None): The service shape name for this resource or None

**Main Methods**:

**load_rename_map()**: Load a name translation map given a shape
- `Parameters`:
  - `shape` (botocore.model.Shape, optional): The underlying shape for this resource. Default: None
- `Returns`: None
- `Note`: Sets up renamed values for any collisions. Precedence order: Load action, Identifiers, Actions, Subresources, References, Collections, Waiters, Attributes. Creates structure like {('action', 'id'): 'id_action'}

**get_attributes()**: Get a dictionary of attribute names to original name and shape models
- `Parameters`:
  - `shape` (botocore.model.Shape): The underlying shape for this resource
- `Returns`: dict - Mapping like {'some_name': ('SomeName', <Shape...>)}
- `Note`: Represents the attributes of this resource, excluding identifiers

**identifiers** (property): Get a list of resource identifiers
- `Parameters`: None
- `Returns`: list(Identifier)

**load** (property): Get the load action for this resource, if it is defined
- `Parameters`: None
- `Returns`: Action or None

**actions** (property): Get a list of actions for this resource
- `Parameters`: None
- `Returns`: list(Action)

**batch_actions** (property): Get a list of batch actions for this resource
- `Parameters`: None
- `Returns`: list(Action)

**subresources** (property): Get a list of sub-resources
- `Parameters`: None
- `Returns`: list(Action)

**references** (property): Get a list of reference resources
- `Parameters`: None
- `Returns`: list(Action)

**collections** (property): Get a list of collections for this resource
- `Parameters`: None
- `Returns`: list(Collection)

**waiters** (property): Get a list of waiters for this resource
- `Parameters`: None
- `Returns`: list(Waiter)

**Internal Methods**:

**_load_name_with_category()**: Load a name with a given category, possibly renaming it
- `Parameters`:
  - `names` (set): Existing names on the resource
  - `name` (str): The original name of the value
  - `category` (str): The value type, such as 'identifier' or 'action'
  - `snake_case` (bool, optional): True (default) if the name should be snake cased
- `Returns`: None
- `Note`: Name will be stored in names and possibly set up in self._renamed. Raises ValueError if problem renaming.

**_get_name()**: Get a possibly renamed value given a category and name
- `Parameters`:
  - `category` (str): The value type, such as 'identifier' or 'action'
  - `name` (str): The original name of the value
  - `snake_case` (bool, optional): True (default) if the name should be snake cased
- `Returns`: str - Either the renamed value if it is set, otherwise the original name
- `Note`: Uses the rename map set up in load_rename_map, so that method must be called once first

**_get_has_definition()**: Get a 'has' relationship definition from a model
- `Parameters`: None
- `Returns`: dict - Mapping of names to subresource and reference definitions
- `Note`: Service resource model is treated special in that it contains a relationship to every resource defined for the service

**_get_related_resources()**: Get a list of sub-resources or references
- `Parameters`:
  - `subresources` (bool): True to get sub-resources, False to get references
- `Returns`: list(Action)

**Usage Example**:
```python
# Note: Used internally by ResourceFactory
from boto3.resources.model import ResourceModel

model = ResourceModel('Bucket', resource_json, all_resource_defs)
```

---

#### 166. Collection Class

**Function Description**: Model class representing a group/collection of resources.

**Import Method**:
```python
from boto3.resources.model import Collection
```

**Parent Class**: `Action`

**Class Signature**:
```python
class Collection(Action):
    """
    A group of resources. See :py:class:`Action`.
    
    :type name: string
    :param name: The name of the collection
    :type definition: dict
    :param definition: The JSON definition
    :type resource_defs: dict
    :param resource_defs: All resources defined in the service
    """
    
    @property
    def batch_actions(self) -> list
```

**Note**: Inherits constructor and all attributes from `Action` class.

**Main Methods**:

**batch_actions** (property): Get a list of batch actions supported by the resource type
- `Parameters`: None
- `Returns`: list(Action)
- `Note`: This is a shortcut for accessing the same information through the resource model (self.resource.model.batch_actions)

**Usage Example**:
```python
# Note: Used internally by ResourceFactory
from boto3.resources.model import Collection

collection = Collection('objects', collection_definition, resource_defs)
```

---

#### 167. CollectionManager Class

**Function Description**: Manager for resource collections providing iteration and filtering.

**Import Method**:
```python
from boto3.resources.collection import CollectionManager
```

**Class Signature**:
```python
class CollectionManager:
    """
    Provides access to resource collection instances with iteration and filtering capabilities.
    Not directly iterable. Must call all(), filter(), or pages() first.
    
    :param collection_model: Collection model
    :param parent: The collection's parent resource
    :param factory: The resource factory to create new resources
    :param service_context: Context about the AWS service
    """
    
    _collection_cls = ResourceCollection
    
    def __init__(self, collection_model, parent, factory, service_context) -> None
    
    def __repr__(self) -> str
    
    def iterator(self, **kwargs) -> ResourceCollection
    
    def all(self) -> ResourceCollection
    
    def filter(self, **kwargs) -> ResourceCollection
    
    def limit(self, count) -> ResourceCollection
    
    def page_size(self, count) -> ResourceCollection
    
    def pages(self) -> PageIterator
```

**Parameters** (__init__ parameters):
- `collection_model` (Collection): Collection model
- `parent` (ServiceResource): The collection's parent resource
- `factory` (ResourceFactory): The resource factory to create new resources
- `service_context` (ServiceContext): Context about the AWS service

**Class Attributes**:
- `_collection_cls` (type): The class to use when creating an iterator. Default: ResourceCollection

**Instance Attributes** (set during initialization):
- `_model` (Collection): Stored collection model
- `_parent` (ServiceResource): The collection's parent resource
- `_handler` (ResourceHandler): Resource handler for creating resource instances

**Main Methods**:

**__repr__()**: String representation of the collection manager
- `Parameters`: None
- `Returns`: str - Format: "CollectionManager(parent, service.ResourceType)"

**iterator()**: Get a resource collection iterator from this manager
- `Parameters`:
  - `**kwargs`: Filter parameters passed to the collection
- `Returns`: ResourceCollection - An iterable representing the collection of resources

**all()**: Get all resources in collection
- `Parameters`: None
- `Returns`: ResourceCollection - Iterator of all resources
- `Note`: Proxies to iterator() with no arguments

**filter()**: Filter collection with parameters
- `Parameters`: 
  - `**kwargs`: Filter parameters
- `Returns`: ResourceCollection - Filtered collection iterator
- `Note`: Proxies to iterator(**kwargs)

**limit()**: Limit number of resources returned
- `Parameters`: 
  - `count` (int): Maximum number of resources
- `Returns`: ResourceCollection - Limited collection iterator
- `Note`: Proxies to iterator(limit=count)

**page_size()**: Set pagination page size
- `Parameters`: 
  - `count` (int): Items per page
- `Returns`: ResourceCollection - Collection iterator with specified page size
- `Note`: Proxies to iterator(page_size=count)

**pages()**: Get page iterator
- `Parameters`: None
- `Returns`: PageIterator - Iterator that yields pages
- `Note`: Proxies to iterator().pages()

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')

# Collections use CollectionManager internally
for bucket in s3.buckets.all():  # .buckets uses CollectionManager
    print(bucket.name)

# Filter collection
ec2 = boto3.resource('ec2')
instances = ec2.instances.filter(Filters=[{'Name': 'instance-state-name', 'Values': ['running']}])
for instance in instances:
    print(instance.id)
```

---

#### 168. CollectionFactory Class

**Function Description**: Factory for creating collection manager instances.

**Import Method**:
```python
from boto3.resources.collection import CollectionFactory
```

**Class Signature**:
```python
class CollectionFactory:
    """
    Factory to create CollectionManager and ResourceCollection subclasses with batch operations.
    """
    
    def load_from_definition(
        self,
        resource_name,
        collection_model,
        service_context,
        event_emitter
    ) -> type
    
    def _load_batch_actions(
        self,
        attrs,
        resource_name,
        collection_model,
        service_model,
        event_emitter
    ) -> None
    
    def _load_documented_collection_methods(
        factory_self,
        attrs,
        resource_name,
        collection_model,
        service_model,
        event_emitter,
        base_class
    ) -> None
    
    def _create_batch_action(
        factory_self,
        resource_name,
        snake_cased,
        action_model,
        collection_model,
        service_model,
        event_emitter
    ) -> callable
```

**Parameters** (__init__ parameters):
- None (no parameters required)

**Main Methods**:

**load_from_definition()**: Loads a collection from a model
- `Parameters`:
  - `resource_name` (str): Name of the resource to look up. For services, this should match the service_name
  - `collection_model` (Collection): Collection model
  - `service_context` (ServiceContext): Context about the AWS service
  - `event_emitter` (HierarchialEmitter): An event emitter
- `Returns`: type - Subclass of CollectionManager. The collection class, e.g. ec2.InstanceCollectionManager
- `Note`: Creates a new CollectionManager subclass with the correct properties and methods. Also creates a new ResourceCollection subclass used by the manager class.

**Internal Methods**:

**_load_batch_actions()**: Load batch actions for the collection
- `Parameters`:
  - `attrs` (dict): Dictionary to store class attributes
  - `resource_name` (str): Name of the resource
  - `collection_model` (Collection): Collection model
  - `service_model` (ServiceModel): Service model
  - `event_emitter` (HierarchialEmitter): Event emitter
- `Returns`: None
- `Note`: Batch actions on the collection become methods on both the collection manager and iterators

**_load_documented_collection_methods()**: Add documented methods to collection class
- `Parameters`:
  - `factory_self`: Factory instance
  - `attrs` (dict): Dictionary to store class attributes
  - `resource_name` (str): Name of the resource
  - `collection_model` (Collection): Collection model
  - `service_model` (ServiceModel): Service model
  - `event_emitter` (HierarchialEmitter): Event emitter
  - `base_class` (type): Base class (ResourceCollection or CollectionManager)
- `Returns`: None
- `Note`: Overrides base class methods (all, filter, limit, page_size) by proxying to base class and adding service-specific docstrings

**_create_batch_action()**: Creates a new method for batch operation
- `Parameters`:
  - `factory_self`: Factory instance
  - `resource_name` (str): Name of the resource
  - `snake_cased` (str): Snake-cased action name
  - `action_model` (Action): Action model
  - `collection_model` (Collection): Collection model
  - `service_model` (ServiceModel): Service model
  - `event_emitter` (HierarchialEmitter): Event emitter
- `Returns`: callable - Batch action method
- `Note`: Creates a new method which makes a batch operation request to the underlying service API

**Usage Example**:
```python
# Note: Used internally by ResourceFactory
from boto3.resources.collection import CollectionFactory

factory = CollectionFactory()
# Used during resource class creation
```

#### 169. ResourceLoadException Class

**Function Description**: Exception raised when a resource definition cannot be loaded from the data files.

**Import Method**:
```python
from boto3.exceptions import ResourceLoadException
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class ResourceLoadException(Boto3Error):
    """Exception raised when a resource cannot be loaded"""
    pass
```

**Usage Example**:
```python
from boto3.exceptions import ResourceLoadException

try:
    # Attempt to load a resource with missing definition
    session.resource('custom-service')
except ResourceLoadException as e:
    print(f"Resource load failed: {e}")
```

#### 170. UnknownAPIVersionError Class

**Function Description**: Exception raised when attempting to create a resource with an API version that does not exist.

**Import Method**:
```python
from boto3.exceptions import UnknownAPIVersionError
```

**Parent Classes**: `Boto3Error`, `botocore.exceptions.DataNotFoundError`

**Class Signature**:
```python
class UnknownAPIVersionError(Boto3Error, botocore.exceptions.DataNotFoundError):
    
    def __init__(self, service_name, bad_api_version, available_api_versions) -> None
```

**Parameters** (__init__ parameters):
- `service_name`: Name of the service
- `bad_api_version`: The invalid API version requested
- `available_api_versions`: List of valid API versions

**Usage Example**:
```python
from boto3.exceptions import UnknownAPIVersionError
import boto3

try:
    s3 = boto3.resource('s3', api_version='2099-01-01')
except UnknownAPIVersionError as e:
    print(f"Invalid API version: {e}")
```

#### 171. ResourceNotExistsError Class

**Function Description**: Exception raised when attempting to create a resource that does not exist for a service.

**Import Method**:
```python
from boto3.exceptions import ResourceNotExistsError
```

**Parent Classes**: `Boto3Error`, `botocore.exceptions.DataNotFoundError`

**Class Signature**:
```python
class ResourceNotExistsError(Boto3Error, botocore.exceptions.DataNotFoundError):
    """Raised when you attempt to create a resource that does not exist."""
    
    def __init__(self, service_name, available_services, has_low_level_client) -> None
```

**Parameters** (__init__ parameters):
- `service_name`: Name of the requested service
- `available_services`: List of available resource services
- `has_low_level_client`: Whether a low-level client is available

**Usage Example**:
```python
from boto3.exceptions import ResourceNotExistsError
import boto3

try:
    resource = boto3.resource('cloudwatch')
except ResourceNotExistsError as e:
    print(f"Resource not available: {e}")
    # Use client instead: boto3.client('cloudwatch')
```

#### 172. DynamoDBNeedsConditionError Class

**Function Description**: Exception raised when a DynamoDB operation expects a ConditionBase object but receives an incompatible type.

**Import Method**:
```python
from boto3.exceptions import DynamoDBNeedsConditionError
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class DynamoDBNeedsConditionError(Boto3Error):
    """Raised when input is not a condition"""
    
    def __init__(self, value) -> None
```

**Parameters** (__init__ parameters):
- `value`: The invalid value passed instead of a ConditionBase

**Usage Example**:
```python
from boto3.exceptions import DynamoDBNeedsConditionError
from boto3.dynamodb.conditions import Attr

# Should use: Attr('name').eq('John')
```

#### 173. DynamoDBNeedsKeyConditionError Class

**Function Description**: Exception raised when a DynamoDB KeyConditionExpression requires a Key object but receives an Attr object.

**Import Method**:
```python
from boto3.exceptions import DynamoDBNeedsKeyConditionError
```

**Parent Class**: `Boto3Error`

**Class Signature**:
```python
class DynamoDBNeedsKeyConditionError(Boto3Error):
    pass
```

**Usage Example**:
```python
from boto3.exceptions import DynamoDBNeedsKeyConditionError
from boto3.dynamodb.conditions import Key, Attr

try:
    table.query(
        KeyConditionExpression=Attr('id').eq('123')  # Wrong! Should use Key
    )
except DynamoDBNeedsKeyConditionError as e:
    print(f"Use Key instead of Attr: {e}")
    # Correct: KeyConditionExpression=Key('id').eq('123')
```

#### 174. ActionDocumenter Class

**Function Description**: Documentation generator for resource action methods.

**Import Method**:
```python
from boto3.docs.action import ActionDocumenter
```

**Parent Class**: `NestedDocumenter`

**Class Signature**:
```python
class ActionDocumenter(NestedDocumenter):
    
    def document_actions(self, section) -> None
```

**Main Methods**:

**document_actions()**: Generate documentation for all actions of a resource
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**Usage Example**:
```python
# Used internally by boto3 documentation generation
from boto3.docs.action import ActionDocumenter

# Generates documentation like:
# bucket.create()
# bucket.delete()
# bucket.upload_file()
```

#### 175. Boto3ClientDocumenter Class

**Function Description**: Documentation generator for boto3 client objects with boto3-specific enhancements.

**Import Method**:
```python
from boto3.docs.client import Boto3ClientDocumenter
```

**Parent Class**: `ClientDocumenter` (from botocore)

**Class Signature**:
```python
class Boto3ClientDocumenter(ClientDocumenter):
    
    def _add_client_creation_example(self, section) -> None
```

**Main Methods**:

**_add_client_creation_example()**: Add client creation example to documentation
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**Usage Example**:
```python
# Used internally to generate client documentation
# Extends botocore's ClientDocumenter with boto3 features
```

#### 176. CollectionDocumenter Class

**Function Description**: Documentation generator for resource collection interfaces.

**Import Method**:
```python
from boto3.docs.collection import CollectionDocumenter
```

**Parent Class**: `NestedDocumenter`

**Class Signature**:
```python
class CollectionDocumenter(NestedDocumenter):
    
    def document_collections(self, section) -> None
    
    def _document_collection(self, section, collection) -> None
```

**Main Methods**:

**document_collections()**: Generate documentation for all collections of a resource
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_document_collection()**: Document a single collection
- `Parameters`:
  - `section`: Documentation section to write to
  - `collection`: Collection model to document
- `Returns`: None

**Usage Example**:
```python
# Used internally to generate collection documentation like:
# bucket.objects.all()
# bucket.objects.filter(Prefix='photos/')
# bucket.objects.limit(100)
```

#### 177. ResourceDocumenter Class

**Function Description**: Base documentation generator for boto3 resource objects.

**Import Method**:
```python
from boto3.docs.resource import ResourceDocumenter
```

**Parent Class**: `BaseDocumenter`

**Class Signature**:
```python
class ResourceDocumenter(BaseDocumenter):
    
    def __init__(self, resource, botocore_session, root_docs_path) -> None
    
    def document_resource(self, section) -> None
    
    def _add_title(self, section) -> None
    
    def _add_intro(self, section) -> None
    
    def _add_description(self, section) -> None
    
    def _add_example(self, section, identifier_names) -> None
    
    def _add_params_description(self, section, identifier_names) -> None
    
    def _add_overview_of_member_type(self, section, resource_member_type) -> None
    
    def _add_identifiers(self, section) -> None
    
    def _add_attributes(self, section) -> None
    
    def _add_references(self, section) -> None
    
    def _add_actions(self, section) -> None
    
    def _add_sub_resources(self, section) -> None
    
    def _add_collections(self, section) -> None
    
    def _add_waiters(self, section) -> None
    
    def _add_resource_note(self, section) -> None
```

**Parameters** (__init__ parameters):
- `resource`: The resource instance to document
- `botocore_session`: Botocore session for accessing service information
- `root_docs_path`: Root path for documentation output

**Instance Attributes** (set during initialization):
- `_botocore_session`: Stored botocore session instance
- `_root_docs_path`: Root path for documentation output
- `_resource_sub_path`: Sub-path for the resource (resource name in lowercase, or 'service-resource' if resource name equals service name)

**Main Methods**:

**document_resource()**: Generate complete documentation for a resource
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_title()**: Add title section to documentation
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_intro()**: Add introduction section with class signature
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_description()**: Add resource description
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_example()**: Add example of resource instantiation
- `Parameters`:
  - `section`: Documentation section to write to
  - `identifier_names`: List of identifier names for the resource
- `Returns`: None

**_add_params_description()**: Add parameter descriptions for identifiers
- `Parameters`:
  - `section`: Documentation section to write to
  - `identifier_names`: List of identifier names
- `Returns`: None

**_add_overview_of_member_type()**: Add overview section for a member type
- `Parameters`:
  - `section`: Documentation section to write to
  - `resource_member_type`: Type of resource member (e.g., 'actions', 'collections')
- `Returns`: None

**_add_identifiers()**: Add documentation for resource identifiers
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_attributes()**: Add documentation for resource attributes
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_references()**: Add documentation for resource references
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_actions()**: Add documentation for resource actions
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_sub_resources()**: Add documentation for sub-resources
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_collections()**: Add documentation for resource collections
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_waiters()**: Add documentation for resource waiters
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_resource_note()**: Add feature freeze note to documentation
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**Usage Example**:
```python
# Used internally to generate resource documentation
# Coordinates sub-documenters for actions, collections, etc.
```

#### 178. ServiceResourceDocumenter Class

**Function Description**: Documentation generator specifically for service resource objects (top-level resources).

**Import Method**:
```python
from boto3.docs.resource import ServiceResourceDocumenter
```

**Parent Class**: `ResourceDocumenter`

**Class Signature**:
```python
class ServiceResourceDocumenter(ResourceDocumenter):
    
    @property
    def class_name(self) -> str
    
    def _add_title(self, section) -> None
    
    def _add_description(self, section) -> None
    
    def _add_example(self, section, identifier_names) -> None
```

**Main Methods**:

**class_name** (property): Get the class name for documentation
- `Parameters`: None
- `Returns`: str - The formatted class name

**_add_title()**: Add title section for service resource
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_description()**: Add service resource description
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_add_example()**: Add service resource instantiation example
- `Parameters`:
  - `section`: Documentation section to write to
  - `identifier_names`: List of identifier names (unused for service resources)
- `Returns`: None

**Usage Example**:
```python
# Used internally to document service resources like:
# s3 = boto3.resource('s3')
# ec2 = boto3.resource('ec2')
```

#### 179. ServiceDocumenter Class

**Function Description**: Top-level documentation generator for an entire AWS service.

**Import Method**:
```python
from boto3.docs.service import ServiceDocumenter
```

**Parent Class**: `BaseServiceDocumenter` (from botocore)

**Class Signature**:
```python
class ServiceDocumenter(BaseServiceDocumenter):
    # The path used to find examples
    EXAMPLE_PATH = os.path.join(os.path.dirname(boto3.__file__), 'examples')
    
    def __init__(self, service_name, session, root_docs_path) -> None
    
    def document_service(self) -> str
    
    def client_api(self, section) -> None
    
    def resource_section(self, section) -> None
    
    def _document_service_resource(self, section) -> None
    
    def _document_resources(self, section) -> None
    
    def _get_example_file(self) -> str
    
    def _document_examples(self, section) -> None
```

**Parameters** (__init__ parameters):
- `service_name`: Name of the AWS service to document
- `session`: Boto3 session instance
- `root_docs_path`: Root path for documentation output

**Class Attributes**:
- `EXAMPLE_PATH` (str): Path to the examples directory

**Instance Attributes** (set during initialization):
- `_boto3_session`: Stored boto3 session instance
- `_client`: Client instance for the service
- `_service_resource`: Service resource instance (None if not available)
- `sections` (list): List of documentation section names = `['title', 'client', 'paginators', 'waiters', 'resources', 'examples', 'context-params']`
- `_root_docs_path`: Root path for documentation output
- `_USER_GUIDE_LINK` (str): URL to the resources user guide = `'https://boto3.amazonaws.com/v1/documentation/api/latest/guide/resources.html'`

**Main Methods**:

**document_service()**: Generate complete service documentation
- `Parameters`: None
- `Returns`: str - The reStructured text of the documented service

**client_api()**: Document the client API
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**resource_section()**: Document the resources section
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_document_service_resource()**: Document the service resource
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_document_resources()**: Document all individual resources
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**_get_example_file()**: Get the path to the examples file
- `Parameters`: None
- `Returns`: str - Path to the examples file

**_document_examples()**: Document examples from file
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**Usage Example**:
```python
# Used internally to generate top-level service documentation
# Includes clients, resources, and all their methods
```

#### 180. SubResourceDocumenter Class

**Function Description**: Documentation generator for sub-resource objects (resources accessed through parent resources).

**Import Method**:
```python
from boto3.docs.subresource import SubResourceDocumenter
```

**Parent Class**: `NestedDocumenter`

**Class Signature**:
```python
class SubResourceDocumenter(NestedDocumenter):
    
    def document_sub_resources(self, section) -> None
```

**Main Methods**:

**document_sub_resources()**: Generate documentation for sub-resources
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**Usage Example**:
```python
# Used internally to document sub-resources like:
# bucket.Object('key')
# queue.Message('receipt_handle')
```

#### 181. WaiterResourceDocumenter Class

**Function Description**: Documentation generator for waiter methods on resources.

**Import Method**:
```python
from boto3.docs.waiter import WaiterResourceDocumenter
```

**Parent Class**: `NestedDocumenter`

**Class Signature**:
```python
class WaiterResourceDocumenter(NestedDocumenter):
    
    def __init__(self, resource, service_waiter_model, root_docs_path) -> None
    
    def document_resource_waiters(self, section) -> None
```

**Parameters** (__init__ parameters):
- `resource`: The resource instance to document
- `service_waiter_model`: Service waiter model
- `root_docs_path`: Root path for documentation output

**Instance Attributes** (set during initialization):
- `_service_waiter_model`: Stored service waiter model

**Main Methods**:

**document_resource_waiters()**: Generate documentation for resource waiters
- `Parameters`:
  - `section`: Documentation section to write to
- `Returns`: None

**Usage Example**:
```python
# Used internally to document waiters like:
# bucket.wait_until_exists()
# instance.wait_until_running()
```

#### 182. LessThanEquals Class

**Function Description**: DynamoDB condition for less than or equal comparison (<=).

**Import Method**:
```python
from boto3.dynamodb.conditions import LessThanEquals
```

**Parent Class**: `ComparisonCondition`

**Class Signature**:
```python
class LessThanEquals(ComparisonCondition):
    expression_operator = '<='
```

**Class Attributes**:
- `expression_operator` (str): The comparison operator = `'<='`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the lte() method (recommended)
condition = Attr('age').lte(30)

# Direct instantiation
from boto3.dynamodb.conditions import LessThanEquals
condition = LessThanEquals(Attr('age'), 30)
```

#### 183. GreaterThanEquals Class

**Function Description**: DynamoDB condition for greater than or equal comparison (>=).

**Import Method**:
```python
from boto3.dynamodb.conditions import GreaterThanEquals
```

**Parent Class**: `ComparisonCondition`

**Class Signature**:
```python
class GreaterThanEquals(ComparisonCondition):
    expression_operator = '>='
```

**Class Attributes**:
- `expression_operator` (str): The comparison operator = `'>='`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the gte() method (recommended)
condition = Attr('price').gte(100)

# Direct instantiation
from boto3.dynamodb.conditions import GreaterThanEquals
condition = GreaterThanEquals(Attr('price'), 100)
```

#### 184. Between Class

**Function Description**: DynamoDB condition for range comparison (value BETWEEN low AND high).

**Import Method**:
```python
from boto3.dynamodb.conditions import Between
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class Between(ConditionBase):
    expression_operator = 'BETWEEN'
    expression_format = '{0} {operator} {1} AND {2}'
```

**Class Attributes**:
- `expression_operator` (str): The operator name = `'BETWEEN'`
- `expression_format` (str): Expression format template = `'{0} {operator} {1} AND {2}'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the between() method (recommended)
condition = Attr('age').between(18, 65)

# Direct instantiation
from boto3.dynamodb.conditions import Between
condition = Between(Attr('age'), 18, 65)
```

#### 185. BeginsWith Class

**Function Description**: DynamoDB condition for string prefix matching.

**Import Method**:
```python
from boto3.dynamodb.conditions import BeginsWith
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class BeginsWith(ConditionBase):
    expression_operator = 'begins_with'
    expression_format = '{operator}({0}, {1})'
```

**Class Attributes**:
- `expression_operator` (str): The operator name = `'begins_with'`
- `expression_format` (str): Expression format template = `'{operator}({0}, {1})'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the begins_with() method (recommended)
condition = Attr('name').begins_with('John')

# Direct instantiation
from boto3.dynamodb.conditions import BeginsWith
condition = BeginsWith(Attr('name'), 'John')
```

#### 186. Contains Class

**Function Description**: DynamoDB condition for substring or set membership checking.

**Import Method**:
```python
from boto3.dynamodb.conditions import Contains
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class Contains(ConditionBase):
    expression_operator = 'contains'
    expression_format = '{operator}({0}, {1})'
```

**Class Attributes**:
- `expression_operator` (str): The operator name = `'contains'`
- `expression_format` (str): Expression format template = `'{operator}({0}, {1})'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Check if string contains substring
condition = Attr('description').contains('AWS')

# Check if list/set contains value
condition = Attr('tags').contains('production')

# Direct instantiation
from boto3.dynamodb.conditions import Contains
condition = Contains(Attr('description'), 'AWS')
```

#### 187. AttributeType Class

**Function Description**: DynamoDB condition for checking attribute type.

**Import Method**:
```python
from boto3.dynamodb.conditions import AttributeType
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class AttributeType(ConditionBase):
    expression_operator = 'attribute_type'
    expression_format = '{operator}({0}, {1})'
```

**Class Attributes**:
- `expression_operator` (str): The operator name = `'attribute_type'`
- `expression_format` (str): Expression format template = `'{operator}({0}, {1})'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Check if attribute is a string
condition = Attr('name').attribute_type('S')

# Check if attribute is a number
condition = Attr('age').attribute_type('N')

# Valid types: 'S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL'
```

#### 188. AttributeExists Class

**Function Description**: DynamoDB condition for checking if an attribute exists.

**Import Method**:
```python
from boto3.dynamodb.conditions import AttributeExists
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class AttributeExists(ConditionBase):
    expression_operator = 'attribute_exists'
    expression_format = '{operator}({0})'
```

**Class Attributes**:
- `expression_operator` (str): The operator name = `'attribute_exists'`
- `expression_format` (str): Expression format template = `'{operator}({0})'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the exists() method (recommended)
condition = Attr('email').exists()

# Direct instantiation
from boto3.dynamodb.conditions import AttributeExists
condition = AttributeExists(Attr('email'))
```

#### 189. AttributeNotExists Class

**Function Description**: DynamoDB condition for checking if an attribute does not exist.

**Import Method**:
```python
from boto3.dynamodb.conditions import AttributeNotExists
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class AttributeNotExists(ConditionBase):
    expression_operator = 'attribute_not_exists'
    expression_format = '{operator}({0})'
```

**Class Attributes**:
- `expression_operator` (str): The operator name = `'attribute_not_exists'`
- `expression_format` (str): Expression format template = `'{operator}({0})'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the not_exists() method (recommended)
condition = Attr('deleted_at').not_exists()

# Direct instantiation
from boto3.dynamodb.conditions import AttributeNotExists
condition = AttributeNotExists(Attr('deleted_at'))
```

#### 190. And Class

**Function Description**: DynamoDB logical AND condition for combining multiple conditions.

**Import Method**:
```python
from boto3.dynamodb.conditions import And
```

**Parent Class**: `ConditionBase`

**Class Signature**:
```python
class And(ConditionBase):
    expression_operator = 'AND'
    expression_format = '({0} {operator} {1})'
```

**Class Attributes**:
- `expression_operator` (str): The logical operator = `'AND'`
- `expression_format` (str): Expression format template = `'({0} {operator} {1})'`

**Usage Example**:
```python
from boto3.dynamodb.conditions import Attr

# Using the & operator (recommended)
condition = Attr('age').gte(18) & Attr('status').eq('active')

# Direct instantiation
from boto3.dynamodb.conditions import And
condition = And(Attr('age').gte(18), Attr('status').eq('active'))
```

#### 191. ServiceAction Class

**Function Description**: Represents a callable action on a resource that performs service operations.

**Import Method**:
```python
from boto3.resources.action import ServiceAction
```

**Class Signature**:
```python
class ServiceAction:
    """
    A class representing a callable action on a resource, for example
    ``sqs.get_queue_by_name(...)`` or ``s3.Bucket('foo').delete()``.
    The action may construct parameters from existing resource identifiers
    and may return either a raw response or a new resource instance.
    
    :type action_model: :py:class`~boto3.resources.model.Action`
    :param action_model: The action model.
    
    :type factory: ResourceFactory
    :param factory: The factory that created the resource class to which
                    this action is attached.
    
    :type service_context: :py:class:`~boto3.utils.ServiceContext`
    :param service_context: Context about the AWS service
    """
    
    def __init__(self, action_model, factory=None, service_context=None) -> None
    
    def __call__(self, parent, *args, **kwargs)
```

**Parameters** (__init__ parameters):
- `action_model`: The action model definition
- `factory`: ResourceFactory instance (default: None)
- `service_context`: Service context information (default: None)

**Instance Attributes** (set during initialization):
- `_action_model`: Stored action model
- `_response_handler`: Handler for processing responses (ResourceHandler or RawHandler depending on whether resource is defined)

**Main Methods**:

**__call__()**: Perform the action's request operation after building operation parameters and build any defined resources from the response
- `Parameters`:
  - `parent`: The resource instance to which this action is attached
  - `*args, **kwargs`: Additional arguments and parameters for the operation
- `Returns`: dict or ServiceResource or list(ServiceResource) - The response, either as a raw dict or resource instance(s)

**Usage Example**:
```python
# Used internally to implement resource methods like:
# bucket.delete()
# instance.terminate()
# queue.send_message(MessageBody='Hello')
```

#### 192. WaiterAction Class

**Function Description**: Represents a callable waiter action on a resource.

**Import Method**:
```python
from boto3.resources.action import WaiterAction
```

**Class Signature**:
```python
class WaiterAction:
    """
    A class representing a callable waiter action on a resource, for example
    ``s3.Bucket('foo').wait_until_bucket_exists()``.
    The waiter action may construct parameters from existing resource
    identifiers.
    
    :type waiter_model: :py:class`~boto3.resources.model.Waiter`
    :param waiter_model: The action waiter.
    :type waiter_resource_name: string
    :param waiter_resource_name: The name of the waiter action for the
                                 resource. It usually begins with a
                                 ``wait_until_``
    """
    
    def __init__(self, waiter_model, waiter_resource_name) -> None
    
    def __call__(self, parent, *args, **kwargs) -> None
```

**Parameters** (__init__ parameters):
- `waiter_model`: The waiter model definition
- `waiter_resource_name`: Name of the waiter action for the resource (usually begins with `wait_until_`)

**Instance Attributes** (set during initialization):
- `_waiter_model`: Stored waiter model
- `_waiter_resource_name`: Stored waiter resource name

**Main Methods**:

**__call__()**: Perform the wait operation after building operation parameters
- `Parameters`:
  - `parent`: The resource instance to which this action is attached
  - `*args, **kwargs`: Additional parameters for the waiter
- `Returns`: None

**Usage Example**:
```python
# Used internally to implement waiter methods like:
# bucket.wait_until_exists()
# instance.wait_until_running()
# snapshot.wait_until_completed()
```

#### 193. ResourceCollection Class

**Function Description**: Represents a collection of resources with iteration and filtering capabilities.

**Import Method**:
```python
from boto3.resources.collection import ResourceCollection
```

**Class Signature**:
```python
class ResourceCollection:
    """
    Represents a collection of resources, which can be iterated through,
    optionally with filtering. Collections automatically handle pagination
    for you.
    
    See :ref:`guide_collections` for a high-level overview of collections,
    including when remote service requests are performed.
    
    :type model: :py:class:`~boto3.resources.model.Collection`
    :param model: Collection model
    :type parent: :py:class:`~boto3.resources.base.ServiceResource`
    :param parent: The collection's parent resource
    :type handler: :py:class:`~boto3.resources.response.ResourceHandler`
    :param handler: The resource response handler used to create resource
                    instances
    """
    
    def __init__(self, model, parent, handler, **kwargs) -> None
    
    def __repr__(self) -> str
    
    def __iter__(self)
    
    def _clone(self, **kwargs)
    
    def pages(self)
    
    def all(self)
    
    def filter(self, **kwargs)
    
    def limit(self, count)
    
    def page_size(self, count)
```

**Parameters** (__init__ parameters):
- `model`: Collection model
- `parent`: The collection's parent resource
- `handler`: The resource response handler used to create resource instances
- `**kwargs`: Additional parameters (e.g., limit, page_size, filter parameters)

**Instance Attributes** (set during initialization):
- `_model`: Stored collection model
- `_parent`: The collection's parent resource
- `_py_operation_name`: Python-style operation name (snake_cased from model.request.operation)
- `_handler`: Resource response handler
- `_params`: Deep copy of kwargs containing collection parameters

**Main Methods**:

**__repr__()**: String representation of the collection
- `Parameters`: None
- `Returns`: str - Format: "ResourceCollection(parent, service.ResourceType)"

**__iter__()**: A generator which yields resource instances after doing the appropriate service operation calls and handling any pagination
- `Parameters`: None
- `Returns`: Iterator of resource instances
- `Note`: Page size, item limit, and filter parameters are applied if they have previously been set

**_clone()**: Create a clone of this collection for chainable interface
- `Parameters`:
  - `**kwargs`: Parameters to merge into the cloned collection
- `Returns`: ResourceCollection - A clone of this resource collection
- `Note`: Returns copies rather than the original, allowing chainable filtering

**pages()**: A generator which yields pages of resource instances after doing the appropriate service operation calls and handling any pagination
- `Parameters`: None
- `Returns`: list(ServiceResource) - List of resource instances per page
- `Note`: Non-paginated calls will return a single page of items. Page size, item limit, and filter parameters are applied if they have previously been set

**all()**: Get all items from the collection, optionally with a custom page size and item count limit
- `Parameters`: None
- `Returns`: ResourceCollection - Iterable generator which yields individual resource instances

**filter()**: Get items from the collection, passing keyword arguments along as parameters to the underlying service operation
- `Parameters`:
  - `**kwargs`: Filter parameters for the underlying service operation
- `Returns`: ResourceCollection - Iterable generator which yields individual resource instances

**limit()**: Return at most this many resources
- `Parameters`:
  - `count` (int): Return no more than this many items
- `Returns`: ResourceCollection

**page_size()**: Fetch at most this many resources per service request
- `Parameters`:
  - `count` (int): Fetch this many items per request
- `Returns`: ResourceCollection

**Usage Example**:
```python
import boto3

s3 = boto3.resource('s3')
bucket = s3.Bucket('my-bucket')

# Iterate through all objects
for obj in bucket.objects.all():
    print(obj.key)

# Filter objects
for obj in bucket.objects.filter(Prefix='photos/'):
    print(obj.key)

# Limit results
for obj in bucket.objects.limit(10):
    print(obj.key)

# Paginate
for page in bucket.objects.pages():
    for obj in page:
        print(obj.key)
```

#### 194. RawHandler Class

**Function Description**: A raw action response handler that passes through the response dictionary, optionally after performing a JMESPath search.

**Import Method**:
```python
from boto3.resources.response import RawHandler
```

**Class Signature**:
```python
class RawHandler:
    """
    A raw action response handler. This passed through the response
    dictionary, optionally after performing a JMESPath search if one
    has been defined for the action.

    :type search_path: string
    :param search_path: JMESPath expression to search in the response
    :rtype: dict
    :return: Service response
    """
    
    def __init__(self, search_path) -> None
    
    def __call__(self, parent, params, response)
```

**Parameters** (__init__ parameters):
- `search_path`: JMESPath expression to search in the response

**Instance Attributes** (set during initialization):
- `search_path`: Stored JMESPath expression

**Main Methods**:

**__call__()**: Process response and return raw data (optionally after JMESPath search)
- `Parameters`:
  - `parent`: ServiceResource - The resource instance to which this action is attached
  - `params` (dict): Request parameters sent to the service
  - `response` (dict): Low-level operation response
- `Returns`: dict - Processed response data (raw or after JMESPath search)

**Usage Example**:
```python
# Used internally when action returns raw response
# The handler extracts specific data using JMESPath if search_path is provided
# Example: Getting reservation data from describe_instances response
```

#### 195. ResourceHandler Class

**Function Description**: Creates new resource or list of new resources from the low-level response based on the given response resource definition.

**Import Method**:
```python
from boto3.resources.response import ResourceHandler
```

**Class Signature**:
```python
class ResourceHandler:
    """
    Creates a new resource or list of new resources from the low-level
    response based on the given response resource definition.

    :type search_path: string
    :param search_path: JMESPath expression to search in the response

    :type factory: ResourceFactory
    :param factory: The factory that created the resource class to which
                    this action is attached.

    :type resource_model: :py:class:`~boto3.resources.model.ResponseResource`
    :param resource_model: Response resource model.

    :type service_context: :py:class:`~boto3.utils.ServiceContext`
    :param service_context: Context about the AWS service

    :type operation_name: string
    :param operation_name: Name of the underlying service operation, if it
                           exists.

    :rtype: ServiceResource or list
    :return: New resource instance(s).
    """
    
    def __init__(
        self,
        search_path,
        factory,
        resource_model,
        service_context,
        operation_name=None
    ) -> None
    
    def __call__(self, parent, params, response)
    
    def handle_response_item(self, resource_cls, parent, identifiers, resource_data)
```

**Parameters** (__init__ parameters):
- `search_path`: JMESPath expression to search in the response
- `factory`: ResourceFactory - The factory that created the resource class to which this action is attached
- `resource_model`: ResponseResource - Response resource model definition
- `service_context`: ServiceContext - Context about the AWS service
- `operation_name`: Name of the underlying service operation, if it exists (optional)

**Instance Attributes** (set during initialization):
- `search_path`: Stored JMESPath expression
- `factory`: Stored resource factory
- `resource_model`: Stored response resource model
- `operation_name`: Stored operation name
- `service_context`: Stored service context

**Main Methods**:

**__call__()**: Process response and create resource instances
- `Parameters`:
  - `parent`: ServiceResource - The resource instance to which this action is attached
  - `params` (dict): Request parameters sent to the service
  - `response` (dict): Low-level operation response
- `Returns`: ServiceResource or list or None - New resource instance(s) or None if identifiers are missing

**handle_response_item()**: Handles the creation of a single response item by setting parameters and creating the appropriate resource instance
- `Parameters`:
  - `resource_cls`: ServiceResource subclass - The resource class to instantiate
  - `parent`: ServiceResource - The resource instance to which this action is attached
  - `identifiers` (dict): Map of identifier names to value or values
  - `resource_data` (dict or None): Data for resource attributes
- `Returns`: ServiceResource - New resource instance

**Usage Example**:
```python
# Used internally when action returns resources
# Example: Creating bucket resource from create_bucket response
# bucket = s3.create_bucket(Bucket='my-bucket')
# Returns a Bucket resource instance with populated identifiers and data
```
