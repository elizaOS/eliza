## Introduction and Goals of the BinaryAlert Project

BinaryAlert is an open-source serverless AWS pipeline **for malware detection** that can scan files uploaded to an S3 bucket in real-time and detect malware using configurable YARA rules. This tool excels in the field of malware detection and can provide a complete solution for "real-time detection and retroactive scanning." Its core functions include: triggering analysis upon file upload (automatically detecting S3 object creation events and triggering Lambda analysis), **YARA rule matching and alerting** (supporting the detection of various malware types and real-time alert notifications), and intelligent handling of special scenarios such as UPX-compressed files, archived files, and CarbonBlack integration. In short, BinaryAlert aims to provide a robust malware detection system for evaluating whether a file contains malicious code (for example, converting a file into an analysis result through `analyze_lambda_handler` and determining whether it matches YARA rules through the `verify` function).

## Natural Language Instructions (Prompt)

Please create a Python project named BinaryAlert to implement a malware detection system. This project should include the following functions:

1. File Parser: Capable of downloading and parsing binary files from an S3 bucket, supporting various file formats (such as executable files, compressed files, archived files, etc.). The parsing result should be analyzable binary data or an equivalent detectable form.

2. YARA Rule Matching: Implement functions (or scripts) to detect malware features using YARA rules, including string matching, regular expression matching, conditional matching, etc. It should support the detection of various malware types, rule compilation and optimization, and real-time matching result notifications.

3. Special Structure Handling: Specifically handle UPX-compressed files, archived files, CarbonBlack integration, S3 event notifications, etc., such as automatically unpacking UPX files, deeply analyzing archived content, and downloading files from CarbonBlack.

4. Interface Design: Design independent command-line interfaces or function interfaces for each functional module (such as file download, YARA analysis, result storage, alert sending, etc.), supporting terminal invocation testing. Each module should define clear input and output formats.

5. Examples and Evaluation Scripts: Provide sample code and test cases to demonstrate how to use the `analyze_lambda_handler` and `verify` functions for file analysis and malware detection (for example, `verify(parse("malware.exe"), yara_rules)` should return the matching result). The above functions need to be combined to build a complete malware detection toolkit. The project should ultimately include modules for file processing, rule matching, and overall detection, along with typical test cases, to form a reproducible detection process.

6. Core File Requirements: The project must include a complete `manage.py` file. This file should not only configure the project as a manageable tool (supporting various management commands) but also declare a complete list of dependencies (including core libraries such as `boto3==1.9.99`, `yara-python==3.8.0`, `cbapi==1.3.6`, `terraform`, `pytest`). `manage.py` can verify whether all functional modules are working properly. At the same time, it is necessary to provide `cli/manager.py` as a unified management entry, import core functions from the `cli`, `lambda_functions`, and `rules` modules, export the `Manager` class and various configuration classes, and provide version information, allowing users to access all major functions through simple statements such as "from cli import ", "from cli.config/exceptions/manager/import ", "from lambda_functions.analyzer/lambda_functions.analyzer.common/lambda_functions/ import ", and "from rules import".

7. Core File Requirements: The project must include a complete `requirements.txt` file. This file should configure the project as an installable package (supporting `pip install`) and declare a complete list of dependencies (such as core libraries actually used, like `defusedxml=0.7.1`, `Jinja2=3.1`, `json5=0.9`, `PyYAML=6.0`). `requirements.txt` should ensure that all core functional modules can work properly. At the same time,it is necessary to provide `lambda_functions/__init__.py`, `cli/__init__.py`, and `rules/__init__.py` as API interfaces, Import and export core function classes, etc, and provide version information, allowing users to access all major functions through simple statements such as "from cli import **"、"from rules import **" and "from lambda_functions import **",etc.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.7.9

### Core Dependency Library Versions

```Plain
alabaster                0.7.12
asn1crypto               0.24.0
astroid                  2.1.0
attrdict                 2.0.1
Babel                    2.6.0
bandit                   1.5.1
boto3                    1.9.99
botocore                 1.12.99
cachetools               3.1.0
cbapi                    1.3.6
certifi                  2018.11.29
cffi                     1.15.0
chardet                  3.0.4
coverage                 4.5.2
coveralls                1.6.0
cryptography             2.5
docopt                   0.6.2
docutils                 0.14
exceptiongroup           1.3.0
futures                  3.1.1
gitdb2                   2.0.5
GitPython                2.1.11
idna                     2.8
imagesize                1.1.0
importlib-metadata       6.7.0
iniconfig                2.0.0
isort                    4.3.4
Jinja2                   2.10
jmespath                 0.9.3
lazy-object-proxy        1.3.1
MarkupSafe               1.1.0
mccabe                   0.6.1
mypy                     0.670
mypy-extensions          0.4.1
packaging                19.0
pbr                      5.1.2
pika                     0.13.0
pip                      21.0.1
pluggy                   1.2.0
ply                      3.10
prompt-toolkit           2.0.9
protobuf                 3.6.1
pycparser                2.19
pyfakefs                 3.5.7
Pygments                 2.3.1
pyhcl                    0.4.0
pylint                   2.2.2
pyOpenSSL                19.0.0
pyparsing                2.3.1
pytest                   7.4.4
python-dateutil          2.6.1
pytz                     2018.9
PyYAML                   3.13
requests                 2.21.0
s3transfer               0.2.0
setuptools               53.0.0
six                      1.12.0
smmap2                   2.0.5
snowballstemmer          1.2.1
Sphinx                   1.8.4
sphinx-rtd-theme         0.4.3
sphinxcontrib-websupport 1.1.0
stevedore                1.30.0
tomli                    2.0.1
typed-ast                1.3.5
typing-extensions        4.7.1
urllib3                  1.24.3
wcwidth                  0.1.7
wheel                    0.36.2
wrapt                    1.11.1
yara-python              4.5.4
zipp                     3.15.0
sphinx-rtd-theme         3.0.2

```

## BinaryAlert Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .bandit
├── .coveragerc
├── .gitignore
├── .pylintrc
├── .travis.yml
├── LICENSE
├── README.rst
├── cli
│   ├── __init__.py
│   ├── config.py
│   ├── enqueue_task.py
│   ├── exceptions.py
│   ├── manager.py
├── docs
│   ├── Makefile
│   ├── images
│   │   ├── architecture.png
│   │   ├── logo.png
│   ├── source
│   │   ├── adding-yara-rules.rst
│   │   ├── analyzing-files.rst
│   │   ├── architecture.rst
│   │   ├── conf.py
│   │   ├── credits.rst
│   │   ├── deploying.rst
│   │   ├── getting-started.rst
│   │   ├── iam-group.rst
│   │   ├── index.rst
│   │   ├── metrics-and-monitoring.rst
│   │   ├── troubleshooting-faq.rst
│   │   └── yara-matches.rst
├── lambda_functions
│   ├── __init__.py
│   ├── analyzer
│   │   ├── README.rst
│   │   ├── __init__.py
│   │   ├── analyzer_aws_lib.py
│   │   ├── binary_info.py
│   │   ├── common.py
│   │   ├── dependencies.zip
│   │   ├── file_hash.py
│   │   ├── main.py
│   │   ├── yara_analyzer.py
│   ├── build.py
│   ├── downloader
│   │   ├── README.rst
│   │   ├── __init__.py
│   │   ├── main.py
│   │   └── requirements.txt
├── manage.py
├── requirements.txt
├── requirements_top_level.txt
├── rules
│   ├── __init__.py
│   ├── clone_rules.py
│   ├── compile_rules.py
│   ├── public
│   │   ├── MachO.yara
│   │   ├── eicar.yara
│   │   ├── hacktool
│   │   │   ├── linux
│   │   │   │   ├── __init__.py
│   │   │   ├── macos
│   │   │   │   ├── hacktool_macos_exploit_cve_2015_5889.yara
│   │   │   │   ├── hacktool_macos_exploit_tpwn.yara
│   │   │   │   ├── hacktool_macos_juuso_keychaindump.yara
│   │   │   │   ├── hacktool_macos_keylogger_b4rsby_swiftlog.yara
│   │   │   │   ├── hacktool_macos_keylogger_caseyscarborough.yara
│   │   │   │   ├── hacktool_macos_keylogger_dannvix.yara
│   │   │   │   ├── hacktool_macos_keylogger_eldeveloper_keystats.yara
│   │   │   │   ├── hacktool_macos_keylogger_giacomolaw.yara
│   │   │   │   ├── hacktool_macos_keylogger_logkext.yara
│   │   │   │   ├── hacktool_macos_keylogger_roxlu_ofxkeylogger.yara
│   │   │   │   ├── hacktool_macos_keylogger_skreweverything_swift.yara
│   │   │   │   ├── hacktool_macos_macpmem.yara
│   │   │   │   ├── hacktool_macos_manwhoami_icloudcontacts.yara
│   │   │   │   ├── hacktool_macos_manwhoami_mmetokendecrypt.yara
│   │   │   │   ├── hacktool_macos_manwhoami_osxchromedecrypt.yara
│   │   │   │   ├── hacktool_macos_n0fate_chainbreaker.yara
│   │   │   │   ├── hacktool_macos_ptoomey3_keychain_dumper.yara
│   │   │   ├── multi
│   │   │   │   ├── hacktool_multi_bloodhound_owned.yara
│   │   │   │   ├── hacktool_multi_jtesta_ssh_mitm.yara
│   │   │   │   ├── hacktool_multi_masscan.yara
│   │   │   │   ├── hacktool_multi_ncc_ABPTTS.yara
│   │   │   │   ├── hacktool_multi_ntlmrelayx.yara
│   │   │   │   ├── hacktool_multi_pyrasite_py.yara
│   │   │   │   ├── hacktool_multi_responder_py.yara
│   │   │   ├── windows
│   │   │   │   ├── hacktool_windows_cobaltstrike_artifact.yara
│   │   │   │   ├── hacktool_windows_cobaltstrike_beacon.yara
│   │   │   │   ├── hacktool_windows_cobaltstrike_postexploitation.yara
│   │   │   │   ├── hacktool_windows_cobaltstrike_powershell.yara
│   │   │   │   ├── hacktool_windows_cobaltstrike_template.yara
│   │   │   │   ├── hacktool_windows_hot_potato.yara
│   │   │   │   ├── hacktool_windows_mimikatz_copywrite.yara
│   │   │   │   ├── hacktool_windows_mimikatz_errors.yara
│   │   │   │   ├── hacktool_windows_mimikatz_files.yara
│   │   │   │   ├── hacktool_windows_mimikatz_modules.yara
│   │   │   │   ├── hacktool_windows_mimikatz_sekurlsa.yara
│   │   │   │   ├── hacktool_windows_moyix_creddump.yara
│   │   │   │   ├── hacktool_windows_ncc_wmicmd.yara
│   │   │   │   ├── hacktool_windows_rdp_cmd_delivery.yara
│   │   │   │   └── hacktool_windows_wmi_implant.yara
│   │   ├── malware
│   │   │   ├── linux
│   │   │   │   ├── __init__.py
│   │   │   ├── macos
│   │   │   │   ├── malware_macos_apt_sofacy_xagent.yara
│   │   │   │   ├── malware_macos_bella.yara
│   │   │   │   ├── malware_macos_macspy.yara
│   │   │   │   ├── malware_macos_marten4n6_evilosx.yara
│   │   │   │   ├── malware_macos_neoneggplant_eggshell.yara
│   │   │   │   ├── malware_macos_proton_rat_generic.yara
│   │   │   ├── multi
│   │   │   │   ├── malware_multi_pupy_rat.yara
│   │   │   │   ├── malware_multi_vesche_basicrat.yara
│   │   │   ├── windows
│   │   │   │   ├── malware_windows_apt_red_leaves_generic.yara
│   │   │   │   ├── malware_windows_apt_whitebear_binary_loader_1.yara
│   │   │   │   ├── malware_windows_apt_whitebear_binary_loader_2.yara
│   │   │   │   ├── malware_windows_apt_whitebear_binary_loader_3.yara
│   │   │   │   ├── malware_windows_ccleaner_backdoor.yara
│   │   │   │   ├── malware_windows_moonlightmaze_IRIX_exploit_GEN.yara
│   │   │   │   ├── malware_windows_moonlightmaze_cle_tool.yara
│   │   │   │   ├── malware_windows_moonlightmaze_custom_sniffer.yara
│   │   │   │   ├── malware_windows_moonlightmaze_de_tool.yara
│   │   │   │   ├── malware_windows_moonlightmaze_encrypted_keyloger.yara
│   │   │   │   ├── malware_windows_moonlightmaze_loki.yara
│   │   │   │   ├── malware_windows_moonlightmaze_loki2crypto.yara
│   │   │   │   ├── malware_windows_moonlightmaze_u_logcleaner.yara
│   │   │   │   ├── malware_windows_moonlightmaze_wipe.yara
│   │   │   │   ├── malware_windows_moonlightmaze_xk_keylogger.yara
│   │   │   │   ├── malware_windows_pony_stealer.yara
│   │   │   │   ├── malware_windows_remcos_rat.yara
│   │   │   │   ├── malware_windows_t3ntman_crunchrat.yara
│   │   │   │   ├── malware_windows_winnti_loadperf_dll_loader.yara
│   │   │   │   └── malware_windows_xrat_quasarrat.yara
│   │   ├── ransomware
│   │   │   ├── linux
│   │   │   │   ├── __init__.py
│   │   │   ├── macos
│   │   │   │   ├── __init__.py
│   │   │   ├── multi
│   │   │   │   ├── __init__.py
│   │   │   └── windows
│   │   │       ├── ransomware_windows_HDDCryptorA.yara
│   │   │       ├── ransomware_windows_cerber_evasion.yara
│   │   │       ├── ransomware_windows_cryptolocker.yara
│   │   │       ├── ransomware_windows_hydracrypt.yara
│   │   │       ├── ransomware_windows_lazarus_wannacry.yara
│   │   │       ├── ransomware_windows_petya_variant_1.yara
│   │   │       ├── ransomware_windows_petya_variant_2.yara
│   │   │       ├── ransomware_windows_petya_variant_3.yara
│   │   │       ├── ransomware_windows_petya_variant_bitcoin.yara
│   │   │       ├── ransomware_windows_powerware_locky.yara
│   │   │       ├── ransomware_windows_wannacry.yara
│   │   │       └── ransomware_windows_zcrypt.yara
│   └── rule_sources.json
└── terraform
    ├── cloudwatch_dashboard.tf
    ├── cloudwatch_metric_alarm.tf
    ├── dynamo.tf
    ├── kms.tf
    ├── lambda.tf
    ├── lambda_iam.tf
    ├── main.tf
    ├── modules
    │   ├── lambda
    │   │   ├── main.tf
    │   │   ├── outputs.tf
    │   │   ├── variables.tf
    │   │   └── versions.tf
    ├── s3.tf
    ├── sns.tf
    ├── sqs.tf
    ├── terraform.tfvars
    ├── variables.tf
    │   ├── downloader
    │   │   ├── __init__.py
    │   │   └── main_test.py
    ├── live_test.py
    └── rules
        ├── __init__.py
        ├── clone_rules_test.py
        ├── compile_rules_test.py
        └── eicar_rule_test.py


```

## API Usage Guide

### Core APIs

#### 1. analyze_lambda_handler() Function - File Analysis Processing

**Required Imports**:
```python

from lambda_functions.analyzer.main import analyze_lambda_handler
```

**Function**: Analyzer Lambda function entry point. Download a file from S3 and perform malware detection using YARA rules.

**Function Signature**:
```python
def analyze_lambda_handler(
    event: Dict[str, Any],
    lambda_context: Any
) -> Dict[str, Any]:
```

**Parameter Description**:
- `event` (Dict[str, Any]): Lambda event containing S3 object information
  - For SQS events: `{"Records": [{"body": "..."}]}`
  - For direct invocation: `{"BucketName": "...", "ObjectKeys": ["..."], "EnableSNSAlerts": bool}`
- `lambda_context` (Any): AWS Lambda context object with runtime information

**Return Value** (Dict[str, Any]): Analysis results dictionary
```python
{
    'S3:bucket:key': {
        'FileInfo': { ... },
        'MatchedRules': { ... },
        'NumMatchedRules': 1
    }
}
```

#### 2. download_lambda_handler() Function - File Download Processing

**Required Imports**:
```python

from lambda_functions.downloader.main import download_lambda_handler
```

**Function**: Lambda function entry point - copy a binary from CarbonBlack into the BinaryAlert S3 bucket.

**Function Signature**:
```python
def download_lambda_handler(event: Dict[str, Any], _: Any) -> None: ...
```

**Parameter Description**:
- `event` (Dict[str, Any]): SQS message batch containing MD5 hash values to download
  - Format: `{"Records": [{"attributes": {"ApproximateReceiveCount": 1}, "body": '{"md5": "FILE_MD5"}', "messageId": "..."}]}`
- `_` (Any): AWS Lambda context object (unused in function)

**Return Value**: None (void function)
- **Side Effects**: 
  - Downloads files from CarbonBl+ack Response API
  - Uploads files to S3 bucket with metadata
  - Publishes CloudWatch metrics for monitoring
  - Logs download statistics and errors

#### 3. CLI Module APIs

**Required Imports**:
```python
from cli.config import BinaryAlertConfig, CONFIG_FILE, VARIABLES_FILE
from cli.manager import Manager
from cli.enqueue_task import EnqueueTask, Worker
from cli.exceptions import ManagerError, InvalidConfigError, TestFailureError
```

##### CLI Config Module (`cli.config`)
- **Class: `BinaryAlertConfig`** - Configuration management for BinaryAlert deployment
```python
class BinaryAlertConfig:
    """Wrapper around reading, validating, and updating the terraform.tfvars config file."""
    def __init__(self) -> None: ...
    @property
    def aws_account_id(self) -> str: ...
    @aws_account_id.setter
    def aws_account_id(self, value: str) -> None: ...
    @property
    def aws_region(self) -> str: ...
    @aws_region.setter
    def aws_region(self, value: str) -> None: ...
    @property
    def name_prefix(self) -> str: ...
    @name_prefix.setter
    def name_prefix(self, value: str) -> None: ...
    @property
    def enable_carbon_black_downloader(self) -> bool: ...
    @enable_carbon_black_downloader.setter
    def enable_carbon_black_downloader(self, value: bool) -> None: ...
    @property
    def carbon_black_url(self) -> str: ...
    @carbon_black_url.setter
    def carbon_black_url(self, value: str) -> None: ...
    @property
    def carbon_black_timeout(self) -> str: ...
    @carbon_black_timeout.setter
    def carbon_black_timeout(self, value: str) -> None: ...
    @property
    def encrypted_carbon_black_api_token(self) -> str: ...
    @encrypted_carbon_black_api_token.setter
    def encrypted_carbon_black_api_token(self, value: str) -> None: ...
    @property
    def plaintext_carbon_black_api_token(self) -> str: ...
    @property
    def force_destroy(self) -> bool: ...
    @property
    def binaryalert_analyzer_name(self) -> str: ...
    @property
    def binaryalert_analyzer_queue_name(self) -> str: ...
    @property
    def binaryalert_downloader_queue_name(self) -> str: ...
    @property
    def binaryalert_dynamo_table_name(self) -> str: ...
    @property
    def binaryalert_s3_bucket_name(self) -> str:
    @property
    def retro_batch_size(self) -> int: ...
    def _encrypt_cb_api_token(self) -> None: ...
    def _configure_carbon_black(self) -> None: ...
    def configure(self) -> None: ...
    def validate(self) -> None: ...
    def save(self) -> None: ...

```
  - **Methods:**
    - `__init__(self) -> None` - Parse terraform.tfvars config file and validate all variables
    - `configure(self) -> None` - Interactively update configuration settings
    - `validate(self) -> None` - Validate config values against expected formats, raises InvalidConfigError if invalid
    - `save(self) -> None` - Save current configuration to terraform.tfvars file
  - **Properties:**
    - `aws_account_id: str` - AWS account ID from configuration file
    - `aws_region: str` - AWS region from configuration file
    - `name_prefix: str` - Name prefix for AWS resources
    - `enable_carbon_black_downloader: bool` - Whether CarbonBlack downloader is enabled
    - `carbon_black_url: str` - CarbonBlack API URL
    - `carbon_black_timeout: int` - CarbonBlack API timeout in seconds
    - `encrypted_carbon_black_token: str` - Encrypted CarbonBlack API token
    - `plaintext_carbon_black_api_token: str` - Plaintext CarbonBlack API token (before encryption)
    - `force_destroy: bool` - Whether to force destroy S3 bucket on teardown
    - `binaries_bucket: str` - S3 bucket name for storing binaries
    - `binaryalert_s3_bucket_name: str` - Full S3 bucket name with prefix
    - `binaryalert_analyzer_name: str` - Full analyzer Lambda function name with prefix
    - `binaryalert_analyzer_queue_name: str` - Full analyzer SQS queue name with prefix
    - `binaryalert_downloader_queue_name: str` - Full downloader SQS queue name with prefix
    - `binaryalert_dynamo_table_name: str` - Full DynamoDB table name with prefix
    - `analysis_queue_name: str` - SQS queue name for analysis tasks
    - `download_queue_name: str` - SQS queue name for download tasks
    - `retro_batch_size: int` - Batch size for retroactive analysis
    - `enable_dynamo_point_in_time_recovery: bool` - Whether DynamoDB PITR is enabled
    - `enable_metrics: bool` - Whether CloudWatch metrics are enabled

##### CLI Manager Module (`cli.manager`)
- **Class: `Manager`** - Main CLI interface for BinaryAlert management
  - **Class Signature:**
    ```python
    class Manager:
      """BinaryAlert management utility."""
      def __init__(self) -> None: ...
      @property
      def commands(self) -> Set[str]: ...
      @property
      def help(self) -> str: ...
      def run(self, command: str) -> None: ...\
      @staticmethod
      def _enqueue(
            queue_name: str, messages: Iterable[Dict[str, Any]],
            summary_func: Callable[[Dict[str, Any]], Tuple[int, str]]) -> None:
      @staticmethod
      def apply() -> None: ...
      def build(self) -> None: ...
      def cb_copy_all(self) -> None: ...
      @staticmethod
      def clone_rules() -> None: ...
      @staticmethod
      def compile_rules() -> None: ...
      def configure(self) -> None: ...
      def deploy(self) -> None: ...
      def destroy(self) -> None: ...
      def live_test(self) -> None: ...
      def purge_queue(self) -> None: ...
      @staticmethod
      def _most_recent_manifest(bucket: boto3.resource) -> Optional[str]: ...
      @staticmethod
      def _inventory_object_iterator(
            bucket: boto3.resource, manifest_path: str) -> Generator[str, None, None]: ...
      def _s3_batch_iterator(
            self, object_keys: Iterable[str]) -> Generator[Dict[str, Any], None, None]: ...
      @staticmethod
      def _s3_msg_summary(sqs_message: Dict[str, Any]) -> Tuple[int, str]: ...
      def retro_fast(self) -> None: ...
      def retro_slow(self) -> None: ...
      @staticmethod
      def unit_test() -> None: ...
    ```
  - **Methods:**
    - `__init__(self) -> None` - Initialize manager by parsing terraform.tfvars config file
    - `run(self, command: str) -> None` - Execute management command, may exit on error
    - `@staticmethod apply() -> None` - Deploy BinaryAlert infrastructure using Terraform
    - `build(self) -> None` - Build Lambda deployment packages
    - `cb_copy_all(self) -> None` - Copy all CarbonBlack binaries for analysis, raises InvalidConfigError if not enabled
    - `@staticmethod clone_rules() -> None` - Clone YARA rules from remote repositories
    - `@staticmethod compile_rules() -> None` - Compile YARA rules into a single file
    - `configure(self) -> None` - Update configuration interactively
    - `deploy(self) -> None` - Deploy BinaryAlert (equivalent to unit_test + build + apply)
    - `destroy(self) -> None` - Destroy all BinaryAlert infrastructure
    - `live_test(self) -> None` - Run live tests of BinaryAlert
    - `purge_queue(self) -> None` - Purge the analysis SQS queue
    - `retro_fast(self) -> None` - Enumerate S3 inventory for fast retroactive analysis
    - `retro_slow(self) -> None` - Enumerate entire S3 bucket for slow retroactive analysis
    - `@staticmethod unit_test() -> None` - Run unit tests, raises TestFailureError if tests fail
  - **Properties:**
    - `@property commands(self) -> Set[str]` - Return set of available management commands
    - `@property help(self) -> str` - Return method docstring for each available command
  - **Properties:**
    - `commands: Set[str]` - Set of available management commands
    - `help: str` - Formatted help text for all commands

##### CLI Enqueue Task Module (`cli.enqueue_task`)
- **Class: `EnqueueTask`** - Task for enqueueing messages to SQS
  - **Class Signature:**
    ```python
    class EnqueueTask:
      def __init__(self, messages: List[str]) -> None: ...
      def run(self, sqs_queue: boto3.resource) -> None: ...

    ```
  - **Methods:**
    - `__init__(self, messages: List[str]) -> None` - Initialize with list of messages to enqueue
    - `run(self, sqs_queue: boto3.resource) -> None` - Send messages to SQS queue
- **Class: `Worker`** - Multi-process worker for task execution (inherits from multiprocessing.Process)
  - **Class Signature:**
    ```python
    class Worker(Process):
    ```
  - **Methods:**
    - `__init__(self, sqs_queue_name: str, task_queue: JoinableQueue) -> None`
      - `sqs_queue_name: str` - Name of the SQS queue to enqueue messages to
      - `task_queue: JoinableQueue` - Queue of tasks to process
    - Initialize with SQS queue name and task queue
    - `run(self) -> None` - Process tasks from the task queue (overrides Process.run())

##### CLI Exceptions Module (`cli.exceptions`)
- **Exceptions:**
  - **`ManagerError(Exception)`** - Base exception for manager-related errors
    - **Class Signature:**
      ```python
      class ManagerError(Exception):
      ```
  - **`InvalidConfigError(ManagerError)`** - Configuration validation errors
    - **Class Signature:**
      ```python
      class InvalidConfigError(ManagerError):
      ```
  - **`TestFailureError(ManagerError)`** - Test execution failures
    - **Class Signature:**
      ```python
      class TestFailureError(ManagerError):
      ```

##### CLI Config Functions Module (`cli.config`)
- **Constants:**
  - `PARENT_DIR: str` - Parent directory path
  - `TERRAFORM_DIR: str` - Terraform configuration directory
  - `CONFIG_FILE: str` - Configuration file path
  - `VARIABLES_FILE: str` - Variables file path
- **Functions:**
  - `get_input(prompt: str, default_value: str, config: Optional[BinaryAlertConfig] = None, property_name: Optional[str] = None) -> str` - Get user input with default value from configuration
    - `prompt: str` - Prompt message to display to the user
    - `default_value: str` - Default value to use if no input is provided
    - `config: Optional[BinaryAlertConfig] = None` - Optional configuration object to read default value from
    - `property_name: Optional[str] = None` - Optional property name to read default value from (if config is provided)
    - Returns: User input string (with default value if no input is provided)

#### 4. Lambda Functions APIs

**Required Imports**:
```python
from botocore.exceptions import ClientError
from lambda_functions.analyzer.main import analyze_lambda_handler
from lambda_functions.analyzer.binary_info import BinaryInfo
from lambda_functions.analyzer.yara_analyzer import YaraAnalyzer, YaraMatch
from lambda_functions.analyzer.analyzer_aws_lib import FileDownloadError
from lambda_functions.analyzer.common import COMPILED_RULES_FILEPATH, LOGGER
from lambda_functions.analyzer import file_hash
from lambda_functions import build
```

##### Analyzer Main Module (`lambda_functions.analyzer.main`)
- **Constants:**
  - `ANALYZER: YaraAnalyzer` - YARA analyzer instance
  - `NUM_YARA_RULES: int` - Number of loaded YARA rules
- **Functions:**
  - `_objects_to_analyze(event: Dict[str, Any]) -> Iterator[Tuple[str, str]]` - Extract S3 bucket/key pairs from Lambda event
    - `event: Dict[str, Any]` - S3 event containing object creation notifications
    - Returns: Iterator of tuples (bucket_name, object_key)
  - `analyze_lambda_handler(event: Dict[str, Any], lambda_context: Any) -> Dict[str, Any]` - Lambda entry point for binary analysis
  - **Parameters:**
    - `event` - S3 event containing object creation notifications
    - `context` - AWS Lambda context object
  - **Returns:** Analysis results including matched YARA rules
  - **Process:** Downloads binary from S3, runs YARA analysis, uploads results to DynamoDB, publishes SNS alerts


##### YARA Analyzer Module (`lambda_functions.analyzer.yara_analyzer`)
- **Constants:**
  - `_YEXTEND_RESULT_KEYS: {'rule_name', 'rule_namespace', 'rule_metadata', 'matched_strings', 'matched_data'}` - Expected keys in yextend JSON output
- **NamedTuple: `YaraMatch`** - Standardized YARA match result (created using collections.namedtuple)
  - **Definition:**
    ```python
    YaraMatch = collections.namedtuple(
        'YaraMatch',
        [
            'rule_name',        # str: Name of the YARA rule
            'rule_namespace',   # str: Namespace of YARA rule (original YARA filename)
            'rule_metadata',    # Dict: String metadata associated with the YARA rule
            'matched_strings',  # Set: Set of string string names matched (e.g. "{$a, $b}")
            'matched_data'      # Set: Matched YARA data
        ]
    )
    ```
  - **Fields:**
    - `rule_name: str` - Name of the matched rule
    - `rule_namespace: str` - Namespace/file of the rule
    - `rule_metadata: Dict[str, Any]` - Rule metadata dictionary
    - `matched_strings: Set[str]` - Set of YARA string identifiers that triggered the match
    - `matched_data: Set[str]` - Set of actual matched data content

- **Class: `YaraAnalyzer`** - YARA rule matching engine
  - **Class Signature:**
    ```python
    class YaraAnalyzer:
    ```
  - **Methods:**
    - `__init__(self, compiled_rules_file: str) -> None` - Initialize with compiled YARA rules file
      - `compiled_rules_file: str` - Path to the binary rules file
    - `@property num_rules(self) -> int` - Get number of loaded YARA rules
    - `@staticmethod _yara_variables(original_target_path: str) -> Dict[str, str]` - Generate YARA external variables for rule matching
      - `original_target_path: str` - Original path of the target file
      - Returns: Dictionary of YARA external variables
    - `_yextend_matches(self, target_file: str) -> List[YaraMatch]` - Run yextend tool for archive and compressed file analysis
      - `target_file: str` - Path to the target file to analyze
      - Returns: List of YaraMatch objects
    - `analyze(self, target_file: str, original_target_path: str = '') -> List[YaraMatch]` - Analyze file with YARA rules and return matches
      - `target_file: str` - Path to the target file to analyze
      - `original_target_path: str = ''` - Optional original path of the target file (for yextend analysis)
      - Returns: List of YaraMatch objects
- **Functions:**
  - `_convert_yextend_to_yara_match(yextend_json: Dict[str, Any]) -> List[YaraMatch]` - Convert Yextend archive analysis results (JSON) into a list of YaraMatch tuples.
    - `yextend_json: Dict[str, Any]` - JSON output from yextend tool
    - Returns: List of YaraMatch objects

##### Binary Info Module (`lambda_functions.analyzer.binary_info`)
- **Class: `BinaryInfo`** - Binary file metadata and analysis wrapper (implements context manager protocol)
  - **Class Signature:**
    ```python
    class BinaryInfo:
    ```
  - **Methods:**
    - `__init__(self, bucket_name: str, object_key: str, yara_analyzer: YaraAnalyzer) -> None` - Initialize with S3 location and YARA analyzer
      - `bucket_name: str` - S3 bucket name
      - `object_key: str` - S3 object key
      - `yara_analyzer: YaraAnalyzer` - YARA analyzer instance for rule matching
    - `__str__(self) -> str` - Return S3 identifier as string representation
    - `_download_from_s3(self) -> None` - Download binary from S3 to local temp file
    - `__enter__(self) -> Any` - Context manager entry: download and analyze binary (returns self; uses Any due to mypy recursive type limitation)
    - `__exit__(self, exception_type: Any, exception_value: Any, traceback: Any) -> None` - Context manager exit: clean up temp files
      - `exception_type: Any` - Exception type if raised (None if no exception)
      - `exception_value: Any` - Exception value if raised (None if no exception)
      - `traceback: Any` - Traceback object if raised (None if no exception)
    - `summary(self) -> Dict[str, Any]` - Generate complete analysis summary with FileInfo and MatchedRules
    - `save_matches_and_alert(self, analyzer_version: int, dynamo_table_name: str, sns_topic_arn: str, sns_enabled: bool = True) -> None` - Save results to DynamoDB and send SNS alerts
      - `analyzer_version: int` - Version of the analyzer used for analysis
      - `dynamo_table_name: str` - Name of the DynamoDB table to store matches
      - `sns_topic_arn: str` - ARN of the SNS topic to publish alerts
      - `sns_enabled: bool = True` - Whether to publish SNS alerts (default: True)
    - `publish_negative_match_result(self, sns_topic_arn: str) -> None` - Publish SNS alert for no YARA matches
      - `sns_topic_arn: str` - ARN of the SNS topic to publish alerts
  - **Properties:**
    - `@property s3_identifier(self) -> str` - S3 identifier in format 'S3:bucket:key'
    - `@property matched_rule_ids(self) -> Set[str]` - Set of 'yara_file:rule_name' for each YARA match (computed property)
    - `@property filepath(self) -> str` - File path from S3 metadata if present (computed property)
  - **Instance Attributes:**
    - `download_path: str` - Temporary file path for downloaded binary
    - `yara_analyzer: YaraAnalyzer` - YARA analyzer instance for rule matching
    - `download_time_ms: float` - Time taken to download file in milliseconds
    - `s3_last_modified: str` - S3 object last modified timestamp
    - `s3_metadata: Dict[str, str]` - S3 object metadata dictionary
    - `computed_md5: str` - Computed MD5 hash of the binary
    - `computed_sha: str` - Computed SHA256 hash of the binary
    - `yara_matches: List[YaraMatch]` - List of YARA rule matches found

##### Analyzer AWS Library (`lambda_functions.analyzer.analyzer_aws_lib`)
- **Constants:**
  - `SNS_PUBLISH_SUBJECT_MAX_SIZE = 99` - Maximum size for SNS subject line (99 characters)
  - `CLOUDWATCH = boto3.client('cloudwatch')` - CloudWatch service client for metrics
  - `DYNAMODB = boto3.resource('dynamodb')` - DynamoDB service resource for match storage
  - `S3 = boto3.resource('s3', config=Config(  # Force a retry after 3 seconds rather than 60 connect_timeout=3, read_timeout=3, retries={'max_attempts': 2}))` - S3 service resource for binary download
  - `SNS: boto3.resource` - SNS service resource for alerts
- **Exceptions:**
  - **`FileDownloadError(Exception)`** - Exception raised when file download from S3 fails with 4XX error (do not retry)
    - **Class Signature:**
      ```python
      class FileDownloadError(Exception):
      ```
- **Classes:**
  - **`DynamoMatchTable`** - Manages YARA match storage in DynamoDB
    - **Class Signature:**
      ```python
      class DynamoMatchTable:
      ```
    - **Methods:**
      - `__init__(self, table_name: str) -> None` - Initialize with DynamoDB table name
      - `save_matches(self, binary: BinaryInfo, analyzer_version: int) -> bool` - Save match results to DynamoDB, returns True if SNS alert should be sent
    - **Private Methods (Important Internal APIs):**
      - `_most_recent_item(self, sha: str) -> Optional[Tuple[int, Set[str], Set[str], Set[str]]]` - Get most recent DynamoDB item for given SHA256, returns tuple of (analyzer_version, matched_rule_ids, s3_objects, s3_metadata_keys) or None if not found
        - `sha: str` - SHA256 hash of the binary to query
    - `@staticmethod def _replace_empty_strings(data: Dict[str, str]) -> Dict[str, str]:` - Replace empty strings with None in nested dictionaries for DynamoDB compatibility
      - `data: Dict[str, str]` - Dictionary to process
      - **Returns:** Processed dictionary with empty strings replaced by None
    - `_create_new_entry(self, binary: BinaryInfo, analyzer_version: int) -> None:` - Create new DynamoDB entry for binary analysis
      - `binary: BinaryInfo` - BinaryInfo object containing match results
      - `analyzer_version: int` - Version of the analyzer used for analysis
    - `def _add_s3_key(self, binary: BinaryInfo, analyzer_version: int) -> None:` - Add S3 object key to DynamoDB entry
      - `binary: BinaryInfo` - BinaryInfo object containing match results
      - `analyzer_version: int` - Version of the analyzer used for analysis
    
- **Functions:**
  - `download_from_s3(bucket_name: str, object_key: str, download_path: str) -> Tuple[str, Dict[str, str]]` - Download file from S3 bucket, returns tuple of (last_modified_time, metadata_dict)
    - `bucket_name: str` - Name of the S3 bucket containing the object
    - `object_key: str` - Key (path) of the object to download
    - `download_path: str` - Local path where the file should be saved
    - **Returns:** Tuple of (last_modified_time, metadata_dict)
  - `_elide_string_middle(text: str, max_length: int) -> str` - Truncate string in middle to fit maximum length while preserving start and end
    - `text: str` - String to elide
    - `max_length: int` - Maximum length of the string after elision
    - **Returns:** Elided string
  - `publish_to_sns(binary: BinaryInfo, topic_arn: str, subject: str) -> None` - Publish YARA match alert to SNS topic
    - `binary: BinaryInfo` - BinaryInfo object containing match results
    - `topic_arn: str` - ARN of the SNS topic to publish alerts
    - `subject: str` - Subject line for the SNS message
  - `_compute_statistics(values: List[Union[int, float]]) -> Dict[str, Union[int, float]]` - Compute statistical metrics (min, max, sum, average) from list of values
    - `values: List[Union[int, float]]` - List of numerical values to compute statistics for
    - **Returns:** Dictionary of computed statistics (min, max, sum, average)
  - `put_metric_data(num_yara_rules: int, binaries: List[BinaryInfo]) -> None` - Send CloudWatch metrics including analyzed binaries count, matched binaries count, YARA rules count, and download latency
    - `num_yara_rules: int` - Number of YARA rules used for analysis
    - `binaries: List[BinaryInfo]` - List of BinaryInfo objects containing analysis results

##### File Hash Module (`lambda_functions.analyzer.file_hash`)
- **Constants:**
  - `MB = 2 ** 20 ` - Megabyte constant for file size calculations (1024 * 1024 bytes)
- **Functions:**
  - `_read_in_chunks(file_object: IO[bytes], chunk_size: int = 2*MB) -> Generator[bytes, None, None]` - Read file in chunks for memory efficiency, yields byte chunks
    - `file_object: IO[bytes]` - File object to read from
    - `chunk_size: int` - Size of each chunk to read (default: 2MB)
    **Returns:** Byte chunks of the file
  - `compute_hashes(file_path: str) -> Tuple[str, str]` - Calculate SHA256 and MD5 hashes of a file
    - **Parameters:**
      - `file_path` (str): Path to the file to hash
    - **Returns:** Tuple of (SHA256_hash_string, MD5_hash_string)
    - **Process:** Reads file in chunks to handle large files efficiently without loading entire file into memory

##### Common Module (`lambda_functions.analyzer.common`)
- **Constants:**
  - `LOGGER = logging.getLogger()` - Configured logger instance
  - `COMPILED_RULES_FILENAME = 'compiled_yara_rules.bin'` - Name of compiled YARA rules file
  - `THIS_DIRECTORY = os.path.dirname(os.path.realpath(__file__))` - Current directory path
  - `COMPILED_RULES_FILEPATH = os.path.join(THIS_DIRECTORY, COMPILED_RULES_FILENAME)` - Path to compiled YARA rules

##### Downloader Main Module (`lambda_functions.downloader.main`)
- **Constants:**
  - `LOGGER: logging.Logger` - Configured logger instance
  - `ENCRYPTED_TOKEN = os.environ['ENCRYPTED_CARBON_BLACK_API_TOKEN']` - Encrypted CarbonBlack API token from environment
  - `DECRYPTED_TOKEN = boto3.client('kms').decrypt(CiphertextBlob=base64.b64decode(ENCRYPTED_TOKEN))['Plaintext']` - Decrypted CarbonBlack API token
  - `CARBON_BLACK: cbapi.CbResponseAPI` - CarbonBlack API client instance
  - `CLOUDWATCH: boto3.client` - CloudWatch service client for metrics
  - `S3_BUCKET: boto3.resource.Bucket` - S3 bucket resource for uploads
- **Functions:**
  - `_iter_download_records(event: Any) -> Generator[Tuple[str, int], None, None]` - Extract MD5 hashes and receive counts from SQS event, yields (md5, receive_count) tuples
    - `event: Any` - SQS message batch with MD5 hashes to download
    **Returns:** Generator of (md5, receive_count) tuples
  - `_build_metadata(binary: Binary) -> Dict[str, str]` - Build S3 metadata dictionary from CarbonBlack binary object
    - `binary: Binary` - CarbonBlack binary object containing metadata
    **Returns:** Dictionary of S3 metadata key-value pairs

  - `_upload_to_s3(binary: Binary) -> None` - Upload CarbonBlack binary to S3 bucket with metadata
    - `binary: Binary` - CarbonBlack binary object containing metadata
  - `_process_md5(md5: str) -> bool` - Download the given file from CarbonBlack and upload to S3, returning True if successful.
    - `md5: str` - MD5 hash of the binary to download
    **Returns:** True if download successful, False otherwise
  - `_publish_metrics(receive_counts: List[int]) -> None` - Publish CloudWatch metrics for download statistics
    - `receive_counts: List[int]` - List of receive counts for processed MD5 hashes.
  - `download_lambda_handler(event: Dict[str, Any], _: Any) -> None` - Lambda entry point for CarbonBlack downloads
    - **Parameters:**
      - `event` (Dict[str, Any]) - SQS message batch with MD5 hashes to download
      - `_` (Any) - Unused Lambda context object
    - **Process:** Queries CarbonBlack API for binaries, downloads them, uploads to S3, publishes metrics

##### Build Module (`lambda_functions.build`)
- **Constants:**
  - `LAMBDA_DIR = os.path.dirname(os.path.realpath(__file__))` - Lambda functions directory path
- **Functions:**
  - `_build_function(function_name: str, target_directory: str, pre_zip_func: Callable[[str], None] = None) -> None` - Build single Lambda function deployment package with dependencies
    - `function_name: str` - Name of the Lambda function to build
    - `target_directory: str` - Directory where to save the built ZIP file
    - `pre_zip_func: Callable[[str], None]` - Optional callback function to run before zipping the package
  - `_build_analyzer_callback(temp_package_dir: str) -> None` - Custom routine to execute before zipping up the analyzer package.
    - `temp_package_dir: str` - Temporary directory where the analyzer package is being built
  - `build(target_directory: str, downloader: bool = False) -> None` - Build Lambda deployment packages for analyzer and optionally downloader
    - **Parameters:**
      - `target_directory` (str): Directory where to save the built ZIP files
      - `downloader` (bool): If True, also build downloader package; if False, only build analyzer
    - **Process:** Installs dependencies via pip, compiles YARA rules, creates ZIP archives with proper file permissions

#### 5. Rules Module APIs

**Required Imports**:
```python
from rules import clone_rules, compile_rules
```

##### Clone Rules Module (`rules.clone_rules`)
- **Constants:**
  - `RULES_DIR = os.path.dirname(os.path.realpath(__file__))` - Rules directory path
  - `REMOTE_RULE_SOURCES = os.path.join(RULES_DIR, 'rule_sources.json')` - Path to rule sources JSON configuration file
- **Functions:**
  - `_copy_required(path: str, include: Optional[List[str]], exclude: Optional[List[str]]) -> bool` - Check if file should be copied based on include/exclude filter lists
    - `path: str` - Path of the file to check
    - `include: Optional[List[str]]` - List of patterns to include; if None, include all
    - `exclude: Optional[List[str]]` - List of patterns to exclude; if None, exclude none
    **Returns:** True if file should be copied, False otherwise
  - `_files_to_copy(cloned_repo_root: str, include: Optional[List[str]], exclude: Optional[List[str]]) -> Generator[str, None, None]` - Generate file paths to copy from cloned repository
    - `cloned_repo_root: str` - Root path of the cloned repository
    - `include: Optional[List[str]]` - List of patterns to include; if None, include all
    - `exclude: Optional[List[str]]` - List of patterns to exclude; if None, exclude none
    **Yields:** Relative file paths to copy from the cloned repository
  - `_clone_repo(url: str, include: Optional[List[str]], exclude: Optional[List[str]]) -> int` - Clone single repository with filtering, returns number of files copied
    - `url: str` - URL of the repository to clone
    - `include: Optional[List[str]]` - List of patterns to include; if None, include all
    - `exclude: Optional[List[str]]` - List of patterns to exclude; if None, exclude none
    **Returns:** Number of files copied from the repository
  - `clone_remote_rules() -> None` - Clone YARA rules from remote repositories configured in rule sources file
    - **Process:** Downloads rules from configured URLs with include/exclude filtering, copies matching files to rules directory

##### Compile Rules Module (`rules.compile_rules`)
- **Constants:**
  - `RULES_DIR = os.path.dirname(os.path.realpath(__file__))` - Rules directory path
- **Functions:**
  - `_find_yara_files() -> Generator[str, None, None]` - Find all YARA rule files in rules directory, yields relative file paths
  - `compile_rules(target_path: str) -> None` - Compile all YARA rules into single binary file
    - **Parameters:**
      - `target_path` (str): Path where to save the compiled rules binary
    - **Process:** Collects all YARA rules, applies namespace mapping, compiles with external variables

#### 6. Type Aliases and Version Information

**Required Imports**:
```python

from lambda_functions.analyzer.yara_analyzer import YaraMatch
```

##### CLI Module (`cli.__init__`)
- **Type Aliases:**
  - `__version__: str` - BinaryAlert version string ("1.2.0")

##### YARA Analyzer Module (`lambda_functions.analyzer.yara_analyzer`)  
- **Type Aliases:**
  - `YaraMatch: NamedTuple` - YARA match result tuple with fields: rule_name, rule_namespace, rule_metadata, matched_strings, matched_data


### Actual Usage Modes

#### Basic Usage

**Required Imports**:
```python
from cli.manager import Manager
```

**Usage Example**:
```python
# Create a manager instance
manager = Manager()

# Deploy BinaryAlert
manager.deploy()

# Run live tests
manager.live_test()
```

#### Configured Usage

**Required Imports**:
```python
from cli.config import BinaryAlertConfig
```

**Usage Example**:
```python
# Customize the configuration
config = BinaryAlertConfig()
config.aws_region = "us-west-2"
config.name_prefix = "my_binaryalert"
config.enable_carbon_black_downloader = True

# Save the configuration
config.save()
```

#### Command-Line Usage Mode

```bash
# Deploy BinaryAlert
python3 manage.py deploy

# Configure settings
python3 manage.py configure

# Run tests
python3 manage.py live_test

# Clone rules
python3 manage.py clone_rules

# Compile rules
python3 manage.py compile_rules
```

### Supported Malware Types

- **Hacking Tools**: CobaltStrike, Mimikatz, BloodHound, etc.
- **Malware**: APT tools, RATs, backdoor programs, etc.
- **Ransomware**: WannaCry, Petya, Cerber, etc.
- **Multi-Platform Malware**: Cross-platform malware detection
- **Special Formats**: UPX-compressed, archived files, encrypted files, etc.

### Error Handling

The system provides a complete error handling mechanism:
- **Timeout Protection**: Prevents the analysis of complex files from taking too long.
- **Format Tolerance**: Automatically handles various file format errors.
- **Fallback Mechanism**: Multiple detection strategies ensure maximum compatibility.
- **Exception Capture**: Gracefully handles analysis failures.

### Important Notes

1. **Function Asymmetry**: The parameter order of the `analyze_lambda_handler()` function is important. `event` should be an S3 event, and `lambda_context` is the Lambda context.
2. **Thread Safety**: Since it uses the AWS Lambda environment, this library supports concurrent processing. If used in multiple threads, set appropriate concurrency limits.
3. **Configuration Priority**: Different `name_prefix` values will affect the naming of AWS resources.
4. **Strict Mode**: When `strict=True`, more precise YARA matching is performed. When `strict=False`, looser matching is allowed.

## Detailed Implementation Nodes of Functions

### Node 1: S3 Event Trigger Analysis

**Function Description**: Process S3 object creation events and automatically trigger the file analysis process. Supports various S3 event formats, including direct invocation and SQS message triggering.

**Core Algorithms**:
- S3 event parsing and validation
- Object key URL decoding
- Batch message processing
- Event format standardization

**Input and Output Examples**:

```python
# Required imports
import json
from typing import Dict, Any
from lambda_functions.analyzer.main import analyze_lambda_handler

# SQS message format event
sqs_event = {
    "Records": [
        {
            "body": json.dumps({
                "Records": [
                    {
                        "s3": {
                            "bucket": {"name": "test-bucket"},
                            "object": {"key": "malware.exe"}
                        }
                    }
                ]
            })
        }
    ]
}

# Direct invocation format event
direct_event = {
    "BucketName": "test-bucket",
    "ObjectKeys": ["malware.exe", "suspicious.pdf"],
    "EnableSNSAlerts": True
}

# Process the SQS event
result = analyze_lambda_handler(sqs_event, lambda_context)
print(result)  
# Example output:
# {
#     'S3:test-bucket:malware.exe': {
#         'FileInfo': {
#             'MD5': 'd41d8cd98f00b204e9800998ecf8427e',
#             'SHA256': 'e3b0c44298fc1c149afbf4c8996fb924...',
#             'S3LastModified': '2024-01-01T12:00:00Z',
#             'S3Location': 'S3:test-bucket:malware.exe',
#             'S3Metadata': {'filepath': '/tmp/malware.exe'}
#         },
#         'MatchedRules': {
#             'Rule1': {
#                 'MatchedData': ['HelloWorld'],
#                 'MatchedStrings': ['$string1'],
#                 'Meta': {'author': 'security_team', 'severity': 'high'},
#                 'RuleFile': 'malware/windows',
#                 'RuleName': 'malware_generic'
#             }
#         },
#         'NumMatchedRules': 1
#     }
# }

# Process the direct invocation event
result = analyze_lambda_handler(direct_event, lambda_context)
print(result)  # Multiple files: {'S3:test-bucket:malware.exe': {...}, 'S3:test-bucket:suspicious.pdf': {...}}
```

### Node 2: File Download and Hash Computation

**Function Description**: Download a file from S3 and calculate its secure hash value, supporting various hash algorithms and metadata extraction.

**Supported Hash Algorithms**:
- MD5: Fast hash calculation
- SHA256: Secure hash standard
- File size and modification time extraction
- S3 metadata retrieval

**Input and Output Examples**:

```python
# Required imports
import hashlib
from lambda_functions.analyzer.binary_info import BinaryInfo
from lambda_functions.analyzer.yara_analyzer import YaraAnalyzer

# Create YARA analyzer first
analyzer = YaraAnalyzer("compiled_rules.bin")

# Create a binary information object
binary_info = BinaryInfo("test-bucket", "malware.exe", analyzer)

# Download the file and calculate the hash
with binary_info as binary:
    print(f"MD5: {binary.computed_md5}")
    print(f"SHA256: {binary.computed_sha}")
    print(f"File Size: {binary.s3_metadata.get('size', 'unknown')}")
    print(f"Last Modified: {binary.s3_last_modified}")

# Hash calculation example
file_content = b"malicious content"
md5_hash = hashlib.md5(file_content).hexdigest()
sha256_hash = hashlib.sha256(file_content).hexdigest()
print(f"MD5: {md5_hash}")
print(f"SHA256: {sha256_hash}")
```

### Node 3: UPX Unpacking Processing

**Function Description**: Automatically detect and unpack UPX-compressed executable files, and extract the original code for analysis.

**Unpacking Strategies**:
- UPX compression detection
- Automatic unpacking processing
- Fault tolerance for unpacking failures
- Temporary file management

**Input and Output Examples**:

```python
# Required imports
import os
import subprocess
from lambda_functions.analyzer.yara_analyzer import YaraAnalyzer

# Note: This is simplified example code. Actual UPX unpacking is handled automatically in YaraAnalyzer.analyze()

# UPX unpacking processing
def unpack_upx(file_path: str) -> bool:
    """
    Try to unpack a UPX-compressed file
    Input: File path
    Output: Whether the unpacking was successful
    """
    try:
        subprocess.check_output(['./upx', '-q', '-d', file_path], stderr=subprocess.STDOUT)
        return True
    except subprocess.CalledProcessError:
        return False

# Unpacking test
original_size = os.path.getsize("malware.exe")
unpacked = unpack_upx("malware.exe")
if unpacked:
    unpacked_size = os.path.getsize("malware.exe")
    print(f"Unpacking successful: {original_size} -> {unpacked_size} bytes")
else:
    print("File is not compressed or unpacking failed")
```

### Node 4: YARA Rule Matching

**Function Description**: Use compiled YARA rules to detect malware in files, supporting various matching strategies and rule types.

**Matching Strategies**:
- String matching
- Regular expression matching
- Conditional matching
- Metadata matching

**Input and Output Examples**:

```python
# Required imports
import yara
from typing import List
from lambda_functions.analyzer.yara_analyzer import YaraAnalyzer, YaraMatch

# Load compiled YARA rules
analyzer = YaraAnalyzer("compiled_rules.bin")

# Analyze a file
matches = analyzer.analyze("malware.exe", "malware.exe")
for match in matches:
    print(f"Rule: {match.rule_name}")
    print(f"Namespace: {match.rule_namespace}")
    print(f"Matched Strings: {match.matched_strings}")
    print(f"Metadata: {match.rule_metadata}")

# Rule statistics
print(f"Number of loaded rules: {analyzer.num_rules}")

# Matching result example
match_result = {
    "rule_name": "malware_generic",
    "namespace": "malware/windows",
    "matched_strings": {"$string1", "$string2"},
    "rule_metadata": {"author": "security_team", "severity": "high"}
}
```

### Node 5: yextend Archive Analysis

**Function Description**: Use the yextend tool to deeply analyze the content of archived files and detect nested malware.

**Analysis Capabilities**:
- Archive file decompression
- Nested file analysis
- Multi-layer detection
- Result aggregation

**Input and Output Examples**:

```python
# Required imports
import json
import subprocess
from typing import List, Dict, Any
from lambda_functions.analyzer.yara_analyzer import YaraAnalyzer

# Note: This is simplified example code. Actual yextend analysis is handled in YaraAnalyzer._yextend_matches()

# yextend archive analysis
def analyze_archive(file_path: str, rules_file: str) -> List[Dict[str, Any]]:
    """
    Analyze an archived file using yextend
    Input: File path and rule file
    Output: Archive analysis result
    """
    try:
        output = subprocess.check_output([
            './yextend', '-r', rules_file, '-t', file_path, '-j'
        ], stderr=subprocess.STDOUT)
        return json.loads(output.decode('utf-8'))
    except subprocess.CalledProcessError:
        return []

# Archive analysis example
archive_result = analyze_archive("suspicious.zip", "compiled_rules.bin")
for item in archive_result:
    if item.get('yara_matches_found'):
        print(f"File: {item.get('file_name', 'unknown')}")
        print(f"Matched Rule: {item.get('yara_rule_id', 'unknown')}")
        print(f"Detected Offsets: {item.get('detected_offsets', [])}")
```

### Node 6: Result Storage to DynamoDB

**Function Description**: Store YARA matching results in a DynamoDB table, supporting version control and deduplication.

**Storage Structure**:
- Primary Key: SHA256 hash
- Sort Key: Analyzer version
- Attributes: Matched rules, file information, timestamp

**Input and Output Examples**:

```python
# Required imports
import time
from typing import Dict, Any, Tuple
from lambda_functions.analyzer.analyzer_aws_lib import DynamoMatchTable
from lambda_functions.analyzer.binary_info import BinaryInfo

# Note: This is simplified example code. Actual result storage is handled in BinaryInfo.save_matches_and_alert()

# Save matching results
def save_matches(binary_info: BinaryInfo, analyzer_version: int, table_name: str) -> Tuple[Dict[str, Any], bool]:
    """
    Save analysis results to DynamoDB
    Input: Binary information, analyzer version, table name
    Output: Stored record
    """
    table = DynamoMatchTable(table_name)
    
    record = {
        'SHA256': binary_info.computed_sha,
        'AnalyzerVersion': analyzer_version,
        'MatchedRules': {
            match.rule_name: {
                'RuleFile': match.rule_namespace,
                'RuleName': match.rule_name,
                'Meta': match.rule_metadata
            } for match in binary_info.yara_matches
        },
        'FileInfo': {
            'MD5': binary_info.computed_md5,
            'S3Location': binary_info.s3_identifier,
            'S3LastModified': binary_info.s3_last_modified,
            'S3Metadata': binary_info.s3_metadata
        },
        'Timestamp': int(time.time())
    }
    
    needs_alert = table.save_matches(binary_info, analyzer_version)
    return record, needs_alert

# Storage example
record, alert_needed = save_matches(binary_info, 1, "yara_matches_table")
print(f"Stored record: {record}")
print(f"Alert needed: {alert_needed}")  # bool: True if new match or new S3 object
```

### Node 7: SNS Alert Sending

**Function Description**: Send malware detection alerts via SNS, supporting various alert formats and notification channels.

**Alert Formats**:
- Alert Subject: Contains file information and matched rules
- Alert Content: Detailed detection results
- Priority: Set according to the malware type

**Input and Output Examples**:

```python
# Required imports
import time
from typing import Dict, Any, List
from lambda_functions.analyzer.analyzer_aws_lib import publish_to_sns
from lambda_functions.analyzer.binary_info import BinaryInfo

# Note: This is simplified example code. Actual SNS publishing is handled in BinaryInfo.save_matches_and_alert()

# Send an alert
def send_malware_alert(binary_info: BinaryInfo, sns_topic_arn: str) -> None:
    """
    Send a malware detection alert
    Input: Binary information and SNS topic ARN
    Output: None (publishes to SNS)
    """
    subject = f"[BinaryAlert] {binary_info.filepath or binary_info.computed_sha} matches YARA rules"

    # Note: publish_to_sns() automatically publishes binary.summary() as the message
    publish_to_sns(binary_info, sns_topic_arn, subject)

# Alert sending example
send_malware_alert(binary_info, "arn:aws:sns:region:account:topic")
print("Alert sent successfully")
```

### Node 8: CarbonBlack File Download

**Function Description**: Download files from the CarbonBlack Response platform and upload them to an S3 bucket, supporting metadata extraction and error handling.

**Download Functions**:
- CarbonBlack API connection
- File download and verification
- Metadata extraction
- Retry mechanism

**Input and Output Examples**:

```python
# Required imports
import os
from typing import Tuple, Dict, Any
import cbapi
from cbapi.response.models import Binary
from lambda_functions.downloader.main import download_lambda_handler

# Note: This is simplified example code. Actual CarbonBlack download is handled in lambda_functions/downloader/main.py

# CarbonBlack file download
def download_from_carbonblack(md5_hash: str, decrypted_token: str) -> Tuple[bytes, Dict[str, Any]]:
    """
    Download a file from CarbonBlack
    Input: MD5 hash value and decrypted API token
    Output: File content and metadata
    """
    carbon_black = cbapi.CbResponseAPI(
        url=os.environ['CARBON_BLACK_URL'],
        timeout=int(os.environ['CARBON_BLACK_TIMEOUT']),
        token=decrypted_token
    )

    binary = carbon_black.select(Binary, md5_hash)
    metadata = {
        'carbon_black_group': binary.group,
        'carbon_black_last_seen': binary.last_seen,
        'carbon_black_os_type': binary.os_type,
        'carbon_black_virustotal_score': str(binary.virustotal.score),
        'carbon_black_webui_link': binary.webui_link,
        'filepath': binary.observed_filenames[0] if binary.observed_filenames else '(unknown)'
    }

    return binary.file, metadata

# Download example (assuming decrypted_token is available)
# decrypted_token = "your_decrypted_token_here"
# file_content, metadata = download_from_carbonblack("d41d8cd98f00b204e9800998ecf8427e", decrypted_token)
# print(f"File size: {len(file_content)} bytes")
# print(f"Metadata: {metadata}")
```

### Node 9: File Upload to S3

**Function Description**: Upload downloaded files to an S3 bucket, supporting metadata setting and encrypted storage.

**Upload Functions**:
- S3 object creation
- Metadata setting
- Encrypted storage
- Access control

**Input and Output Examples**:

```python
# Required imports
import boto3
from typing import Dict, Any, IO
from botocore.exceptions import ClientError

# Note: This is simplified example code. Actual S3 upload is handled in lambda_functions/downloader/main.py

# File upload to S3
def upload_to_s3(file_content: IO, metadata: Dict[str, str], bucket_name: str, object_key: str) -> bool:
    """
    Upload a file to S3
    Input: File content, metadata, bucket name, object key
    Output: Upload result
    """
    s3_bucket = boto3.resource('s3').Bucket(bucket_name)
    
    try:
        s3_bucket.upload_fileobj(
            file_content,
            object_key,
            ExtraArgs={'Metadata': metadata}
        )
        return True
    except ClientError as e:
        print(f"Upload failed: {e}")
        return False

# Upload example
success = upload_to_s3(
    file_content,
    metadata,
    "binaryalert-binaries",
    "carbonblack/d41d8cd98f00b204e9800998ecf8427e"
)
print(f"Upload successful: {success}")
```

## Summary

The BinaryAlert project provides a comprehensive serverless malware detection system with the following key capabilities:

### Core Features
- **Real-time file analysis** using AWS Lambda and YARA rules
- **Scalable architecture** supporting high-volume file processing  
- **Flexible rule management** with support for custom YARA rules
- **Comprehensive monitoring** via CloudWatch metrics and SNS alerts
- **Multi-format support** including UPX-compressed and archived files
- **CarbonBlack integration** for enterprise threat intelligence

### API Coverage
This documentation covers **100+ APIs** across all major modules:
- **CLI Management**: Configuration, deployment, and administration tools
- **Lambda Functions**: File analysis and download processing
- **Rule Management**: YARA rule compilation and distribution
- **Testing Framework**: Comprehensive test coverage with mock objects
- **AWS Integration**: S3, DynamoDB, SNS, and CloudWatch services

### Getting Started
1. Configure your AWS environment using `BinaryAlertConfig`
2. Deploy the infrastructure with `Manager.deploy()`
3. Upload files to the configured S3 bucket for automatic analysis
4. Monitor results via CloudWatch dashboards and SNS notifications

For detailed implementation examples and API usage, refer to the specific module sections above.
