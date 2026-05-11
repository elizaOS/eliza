# WooCommerce Stock Alert S2L Environment

## Overview

The WooCommerce Stock Alert S2L environment simulates an e-commerce inventory monitoring scenario where an AI agent needs to:

1. **Monitor Product Inventory**: Check all products in WooCommerce store
2. **Identify Low-Stock Products**: Find products where current stock < safety threshold
3. **Update Google Sheets**: Add low-stock products to a "Stock Alert" spreadsheet
4. **Send Email Notifications**: Alert the purchasing manager about each low-stock product

## Task Description

The agent is given access to:
- WooCommerce API (via MCP server) to query product inventory
- Google Sheets API (via MCP server) to update stock alert sheet
- Email system (via MCP server) to send notifications
- Admin credentials for authentication

The agent must:
- Query all products from WooCommerce
- Calculate which products have stock_quantity < stock_threshold
- Add these products to the Google Sheet with required columns
- Send individual email alerts to purchasing manager (laura_thompson@mcp.com)
- Follow the provided email template format

## Environment Configuration

### Initialization Parameters

```python
env = WoocommerceStockAlertS2LEnv(
    task_dir="/path/to/task/dir",        # Directory for task files
    num_low_stock=10,                     # Number of low-stock products
    num_normal_stock=100,                 # Number of normal-stock products
    seed=42,                              # Random seed for reproducibility
    difficulty="medium",                  # Difficulty preset (optional)
    verbose=False                         # Console logging
)
```

### Difficulty Levels

- **easy**: 3 low-stock, 5 normal-stock products
- **medium**: 5 low-stock, 10 normal-stock products
- **hard**: 10 low-stock, 20 normal-stock products
- **expert**: 20 low-stock, 40 normal-stock products
- **extreme**: 50 low-stock, 100 normal-stock products
- **ultra**: 100 low-stock, 150 normal-stock products
- **insane**: 150 low-stock, 200 normal-stock products

## Directory Structure

```
woocommerce_stock_alert_s2l/
├── woocommerce_stock_alert_s2l.py  # Main environment class
├── __init__.py                      # Package initialization
├── README.md                        # This file
├── emails_config.json               # Email configuration
├── preprocess/                      # Preprocessing scripts
│   ├── main.py                      # Main preprocessing script
│   ├── woocommerce_client.py        # WooCommerce API client
│   ├── sync_woocommerce.py          # Product sync utilities
│   └── woocommerce_products.json    # Generated product data
├── evaluation/                      # Evaluation scripts
│   ├── main.py                      # Main evaluation script
│   └── evaluate_updated_stock_alert.py  # Stock alert evaluator
└── initial_workspace/               # Initial files for agent
    ├── admin_credentials.txt        # Admin account credentials
    ├── purchasing_manager_email.txt # Purchasing manager email
    └── stock_alert_email_template.md # Email template
```

## Task Workflow

### Reset Phase (Preprocessing)

1. **Generate Product Data**: Create products with varying stock levels
2. **Initialize Databases**: Set up WooCommerce, Email, Google Sheets databases
3. **Sync Products**: Load products into WooCommerce
4. **Initialize Sheet**: Create Google Sheet with template row
5. **Prepare Workspace**: Copy initial files to agent workspace

### Agent Execution Phase

The agent receives the task instruction and workspace files:
- `admin_credentials.txt`: Contains WooCommerce and email credentials
- `purchasing_manager_email.txt`: Email address for notifications
- `stock_alert_email_template.md`: Template for email format

The agent should:
1. Authenticate with WooCommerce and Google Sheets
2. Query all products from WooCommerce
3. Identify products with stock_quantity < stock_threshold
4. Add these products to the "Stock Alert" Google Sheet
5. Send email notifications to purchasing manager

### Evaluation Phase (Step)

1. **Validate Google Sheets**:
   - All low-stock products present
   - No normal-stock products included
   - Correct data (SKU, stock levels, supplier info)
   - All required columns filled

2. **Validate Email Notifications**:
   - Emails sent to purchasing manager
   - One email per low-stock product
   - Follows template format
   - Contains product details

## Required Google Sheets Columns

- Product ID
- Product Name
- SKU
- Current Stock
- Safety Threshold
- Supplier Name
- Supplier ID
- Supplier Contact

## Email Template Format

Subject: `[Stock Alert] {product_name} Stock Below Safety Threshold`

Body should include:
- Greeting to Purchasing Manager
- Product details (name, SKU, stock, threshold)
- Supplier information
- Link to Google Sheets (if available)
- Call to action

## Database Configuration

The environment uses local databases for:
- **WooCommerce**: Product inventory and metadata
- **Email**: Email storage and delivery
- **Google Sheets**: Spreadsheet data

Database directories are created in `{task_dir}/local_db/`:
- `woocommerce/`
- `emails/`
- `google_sheets/`

## Admin Credentials

Default admin account:
- Email: `admin@woocommerce.local`
- Password: `admin123`

Purchasing Manager:
- Email: `laura_thompson@mcp.com`

## Evaluation Criteria

The task is considered successful when:

1. **Google Sheets Validation** ✓
   - All low-stock products added to sheet
   - No false positives (normal-stock products)
   - Accurate data for all required columns
   
2. **Email Validation** ✓
   - Correct number of emails sent
   - All emails to purchasing manager
   - Template format followed
   - Product details included

## Example Usage

```python
from gem.envs.woocommerce_stock_alert_s2l import WoocommerceStockAlertS2LEnv

# Create environment with medium difficulty
env = WoocommerceStockAlertS2LEnv(
    task_dir="/tmp/stock_alert_task",
    difficulty="medium",
    verbose=True
)

# Reset environment (runs preprocessing)
instruction, info = env.reset()
print(instruction)

# Agent executes task...
# (WooCommerce queries, Google Sheets updates, email sending)

# Evaluate results
observation, reward, terminated, truncated, info = env.step("claim_done")
print(f"Success: {info['success']}")
print(f"Reward: {reward}")
```

## Parallel Execution Support

The environment is designed to support parallel execution:
- Uses unique logger names based on instance ID
- Generates files in task-specific directories
- Avoids module naming conflicts with dynamic imports
- Independent database instances per task

## Notes

- The environment automatically copies required files from the source task directory
- Preprocessing generates product data based on difficulty settings
- All intermediate files are stored in the task directory, not the code directory
- The environment supports custom difficulty settings or predefined presets


