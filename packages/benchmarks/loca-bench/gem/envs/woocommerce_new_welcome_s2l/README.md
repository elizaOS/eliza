# WooCommerce New Welcome S2L Environment

## Overview

This environment simulates a new customer onboarding scenario for an e-commerce business. The agent must identify first-time customers from WooCommerce, sync them to the company CRM (BigQuery), and send personalized welcome emails.

## Task Description

### Objective

1. **Detect New Customers**: Identify customers who placed their first order in the past 7 days
2. **Sync to BigQuery**: Update the company CRM with new customer information
3. **Send Welcome Emails**: Send personalized welcome emails using the provided template

### New Customer Definition

A new customer is someone who:
- Placed their first order within the past 7 days
- Has no previous order history
- Has a completed order (status = 'completed')

### Evaluation Criteria

The task is evaluated on three main aspects:

1. **Customer Identification** (Correctness)
   - Correctly identify all first-time customers
   - Filter out orders outside the 7-day window
   - Filter out incomplete orders (processing, on-hold, etc.)
   - Do NOT include historical customers

2. **BigQuery Sync** (Data Integrity)
   - Sync ONLY first-time customers to BigQuery
   - Mark `welcome_email_sent = true` for new customers
   - Preserve all existing customer data
   - No duplicate insertions

3. **Email Delivery** (Completeness & Format)
   - Send welcome emails to ALL first-time customers
   - Use the provided email template
   - Include order details (order ID, amount, date)
   - Do NOT send emails to historical customers

## Environment Setup

### Initialization Parameters

```python
env = WoocommerceNewWelcomeS2LEnv(
    task_dir="/path/to/task",
    total_orders=20,              # Total orders to generate
    first_time_customers=10,       # Number of first-time customers
    noise_outside_window=0,        # Noise orders outside 7-day window
    noise_incomplete=0,            # Noise orders with incomplete status
    seed=42,                       # Random seed for reproducibility
    difficulty=None,               # Or: "easy", "medium", "hard", "expert", "extreme"
    verbose=False                  # Console logging
)
```

### Difficulty Presets

- **Easy**: 20 orders, 15 first-time customers, no noise
- **Medium**: 30 orders, 12 first-time customers, 5 noise orders
- **Hard**: 50 orders, 15 first-time customers, 13 noise orders
- **Expert**: 80 orders, 20 first-time customers, 25 noise orders
- **Extreme**: 120 orders, 25 first-time customers, 40 noise orders

## Required MCP Servers

- `woocommerce-simplified`: Query WooCommerce orders and customers
- `google-cloud-simplified`: Access BigQuery CRM database
- `emails-simplified`: Send welcome emails
- `filesystem`: Read workspace files

## Local Tools

- `python_execute`: Execute Python scripts
- `claim_done`: Mark task as complete
- `handle_overlong_tool_outputs`: Handle long outputs

## Database Configuration

### WooCommerce
- Local database at `{task_dir}/local_db/woocommerce`
- Contains orders and customers

### BigQuery (Local)
- Local database at `{task_dir}/local_db/google_cloud`
- Project: `local-project`
- Dataset: `woocommerce_crm`
- Table: `customers`

### Email
- Local database at `{task_dir}/local_db/emails`
- Admin account: `admin@woocommerce.local`

## Workspace Files

The agent workspace contains:

- `welcome_email_template.md`: Email template with placeholders
- `admin_credentials.txt`: Admin credentials (if needed)
- `woocommerce_orders.json`: Sample orders (for reference)

## Implementation Details

### Preprocessing

The preprocessing step:
1. Clears email database
2. Generates WooCommerce orders with:
   - First-time customers (within 7 days, completed)
   - Noise orders (outside window or incomplete)
   - Historical customers (old orders)
3. Initializes BigQuery with historical customer data
4. Creates email accounts for all customers
5. Copies workspace files

### Evaluation

The evaluation checks:
1. **BigQuery Data Integrity**:
   - Initial customer data is preserved
   - New customers are correctly inserted/updated
   - `welcome_email_sent` and `welcome_email_date` are set
   - No incorrect insertions or updates

2. **Welcome Email Validation**:
   - Emails sent to all first-time customers
   - Email subject and content match template
   - Order details included in email
   - No emails sent to historical customers

## Usage Example

```python
from gem.envs.woocommerce_new_welcome_s2l import WoocommerceNewWelcomeS2LEnv

# Initialize environment
env = WoocommerceNewWelcomeS2LEnv(
    task_dir="/tmp/woocommerce_task",
    difficulty="medium",
    verbose=True
)

# Reset and get task instruction
instruction, info = env.reset()
print(instruction)

# Agent performs task...
# (Query WooCommerce, sync to BigQuery, send emails)

# Evaluate task completion
observation, reward, terminated, truncated, info = env.step("claim_done")
print(f"Success: {info['success']}")
print(f"Reward: {reward}")
```

## Common Pitfalls

1. **Including Historical Customers**: Only sync customers whose FIRST order is within the past 7 days
2. **Ignoring Order Status**: Only consider completed orders
3. **Missing Email Template**: Use the provided template with all placeholders filled
4. **Not Marking in BigQuery**: Must set `welcome_email_sent = true` after sending
5. **Duplicate Syncing**: Check if customer already exists in BigQuery before inserting

## Directory Structure

```
woocommerce_new_welcome_s2l/
├── woocommerce_new_welcome_s2l.py  # Main environment class
├── __init__.py                      # Module initialization
├── README.md                        # This file
├── preprocess/                      # Preprocessing scripts
│   ├── main.py                      # Main preprocessing logic
│   ├── generated_orders.json        # Generated orders (after reset)
│   ├── customers_data.json          # Historical customer data
│   └── woocommerce_data.json        # WooCommerce configuration
├── evaluation/                      # Evaluation scripts
│   └── main.py                      # Main evaluation logic
├── initial_workspace/               # Initial workspace files
│   ├── welcome_email_template.md    # Email template
│   ├── admin_credentials.txt        # Admin credentials
│   └── woocommerce_orders.json      # Sample orders
└── emails_config.json               # Email server configuration
```

## Notes

- This environment supports parallel execution (each instance uses separate task directory)
- Module names are made unique per instance to avoid conflicts
- All intermediate files are stored in task directory, not code directory
- Databases are isolated per task instance

## References

- Based on the `filter-low-selling-products-s2l` task structure
- Uses local database implementations for WooCommerce, Email, and BigQuery
- Evaluation focuses on correctness, data integrity, and completeness

