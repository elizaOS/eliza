# Payable Invoice Checker S2L Environment

## Overview

The Payable Invoice Checker S2L Environment simulates a financial scenario where an AI agent must process invoice PDF files, update a Snowflake database, and send email notifications to purchasing managers for unpaid invoices.

## Task Description

The agent needs to:
1. **Extract invoice data** from PDF files in the workspace
2. **Update Snowflake database tables**:
   - Insert invoice data into `PURCHASE_INVOICE.PUBLIC.INVOICES` table
   - Insert payment data into `PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS` table
   - Preserve existing interference data (no damage to existing records)
3. **Set column description** for `OUTSTANDING_FLAG` as: `"0=Paid, 1=Outstanding"`
4. **Send email notifications** to purchasing managers for unpaid invoices
   - Subject: "Process Outstanding Invoices"
   - Body: Include all unpaid invoice filenames for that manager

## Environment Structure

```
payable_invoice_checker_s2l/
├── __init__.py                          # Module initialization
├── payable_invoice_checker_s2l.py       # Main environment class
├── README.md                            # This file
├── email_config.json                    # Email configuration
├── token_key_session.py                 # Token/session configuration
├── preprocess/                          # Preprocessing scripts
│   ├── main.py                          # Main preprocessing script
│   ├── generate_test_invoices.py       # Invoice PDF generator
│   └── create_snowflake_db.py          # Database initialization
├── evaluation/                          # Evaluation scripts
│   ├── main.py                          # Main evaluation script
│   ├── check_snowflake.py              # Database validation
│   └── check_emails.py                 # Email validation
├── initial_workspace/                   # Initial workspace files
│   └── email_account.txt               # Email account credentials
└── files/                               # Supporting files
    └── involved_emails.json            # Email configuration
```

## Usage

### Basic Usage

```python
from gem.envs.payable_invoice_checker_s2l import PayableInvoiceCheckerS2LEnv

# Create environment with default settings
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    verbose=True
)

# Get initial task instruction
instruction, info = env.reset()

# Agent performs actions...
# When agent claims task is done:
observation, reward, terminated, truncated, info = env.step("claim_done")
```

### Custom Configuration

```python
# Custom parameters
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    num_invoices=50,           # Number of invoice PDFs to generate
    num_interference=2000,     # Number of interference records in database
    seed=123,                  # Random seed for reproducibility
    verbose=True
)
```

### Difficulty Presets

The environment supports several difficulty presets:

```python
# Easy: Few invoices, minimal interference
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    difficulty="easy"
)
# num_invoices=5, num_interference=100

# Medium: Moderate invoices and interference
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    difficulty="medium"
)
# num_invoices=15, num_interference=1000

# Hard: More invoices and interference
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    difficulty="hard"
)
# num_invoices=30, num_interference=3000

# Expert: Many invoices with high interference
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    difficulty="expert"
)
# num_invoices=50, num_interference=5000

# Extreme: Maximum complexity
env = PayableInvoiceCheckerS2LEnv(
    task_dir="/path/to/task_dir",
    difficulty="extreme"
)
# num_invoices=100, num_interference=10000
```

## Preprocessing

The preprocessing phase (executed in `reset()`):

1. **Generate Invoice PDFs**: Creates invoice PDF files with varying formats and styles
2. **Initialize Snowflake Database**: 
   - Creates `PURCHASE_INVOICE.PUBLIC.INVOICES` table
   - Creates `PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS` table
   - Populates with interference data (paid invoices from previous periods)
3. **Initialize Email Database**: Sets up email accounts for all involved parties
4. **Generate Groundtruth**: Creates reference data for evaluation
5. **Setup Agent Workspace**: Copies initial files and invoice PDFs to agent workspace

## Evaluation

The evaluation phase (executed in `step()`):

### 1. Snowflake Database Validation
- **Invoice Data**: All invoice IDs from PDFs correctly inserted
- **Payment Data**: All payment statuses correctly set
- **Interference Preservation**: Existing data not damaged
- **Column Description**: OUTSTANDING_FLAG description set correctly

### 2. Email Validation
- **Correct Recipients**: Emails sent only to buyers with unpaid invoices
- **Email Content**: All unpaid invoice filenames included
- **Email Subject**: Correct subject line used
- **No Extra Emails**: No emails sent to buyers with only paid invoices

## Parallel Execution Support

This environment is designed to support parallel execution:

1. **Isolated Task Directories**: Each instance uses its own `task_dir`
2. **Unique Module Names**: Preprocessing and evaluation modules use instance-specific names
3. **Separate Databases**: Each instance has isolated Snowflake and Email databases
4. **No Shared State**: All intermediate files stored in instance-specific directories

## Database Schema

### PURCHASE_INVOICE.PUBLIC.INVOICES

| Column Name        | Type          | Description                    |
|-------------------|---------------|--------------------------------|
| INVOICE_ID        | VARCHAR(100)  | Primary key, invoice number    |
| SUPPLIER_NAME     | VARCHAR(500)  | Supplier company name          |
| INVOICE_AMOUNT    | DECIMAL(15,2) | Total invoice amount           |
| PURCHASER_EMAIL   | VARCHAR(255)  | Buyer's email address          |
| INVOICE_DATE      | DATE          | Invoice date                   |

### PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS

| Column Name        | Type          | Description                    |
|-------------------|---------------|--------------------------------|
| INVOICE_ID        | VARCHAR(100)  | Primary key, invoice number    |
| PAYMENT_AMOUNT    | DECIMAL(15,2) | Amount paid                    |
| OUTSTANDING_FLAG  | INTEGER       | 0=Paid, 1=Outstanding          |

## Dependencies

- **Python 3.8+**
- **gem**: Core environment framework
- **Local databases**:
  - Snowflake database (via `mcps.snowflake.database_utils`)
  - Email database (via `mcps.email.database_utils`)
- **PDF generation**: reportlab, PyPDF2 (in preprocessing)

## Notes

1. **Module Conflict Prevention**: The environment uses subprocess execution for preprocessing and evaluation to avoid module naming conflicts in parallel execution
2. **Database Isolation**: Each instance maintains separate local databases in `task_dir/local_db/`
3. **File Organization**: All generated files (invoices, groundtruth, etc.) are stored in `task_dir`, not in the code directory
4. **Logging**: Comprehensive logging to `task_dir/logs/env.log` with optional console output in verbose mode

## Example Task Flow

1. **Environment Reset**:
   - Generate 30 invoice PDFs with various formats
   - Create Snowflake database with 1000 interference records
   - Initialize email accounts
   - Copy files to agent workspace

2. **Agent Actions**:
   - Read invoice PDFs from workspace
   - Extract invoice data (ID, supplier, amount, buyer, date)
   - Determine payment status
   - Insert data into Snowflake tables
   - Set column description for OUTSTANDING_FLAG
   - Identify buyers with unpaid invoices
   - Send emails to each buyer with their unpaid invoice list

3. **Evaluation**:
   - Verify all invoices inserted correctly
   - Check payment statuses match groundtruth
   - Confirm interference data preserved
   - Validate column description set
   - Check emails sent to correct recipients
   - Verify email content includes all unpaid invoices

## Success Criteria

The task is considered successful when:
- ✅ All invoice data correctly inserted into Snowflake
- ✅ All payment statuses are correct
- ✅ Interference data preserved (no damage)
- ✅ Column description set correctly
- ✅ Emails sent to correct purchasing managers
- ✅ Email content includes all unpaid invoice filenames
- ✅ No extra emails sent

## Common Pitfalls

1. **PDF Parsing**: Invoice PDFs have various formats - agent must handle different layouts
2. **Payment Status Logic**: Must correctly determine paid vs unpaid based on amount comparisons
3. **Database Integrity**: Must preserve existing interference data
4. **Email Grouping**: Must group unpaid invoices by buyer and send one email per buyer
5. **Column Description**: Must set exact description text for OUTSTANDING_FLAG

## See Also

- [Task Documentation](../../mcpbench_dev/tasks/weihao/payable-invoice-checker-s2l/docs/task.md)
- [Preprocessing Implementation](./preprocess/main.py)
- [Evaluation Implementation](./evaluation/main.py)




