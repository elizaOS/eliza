# Filter Low Selling Products S2L Environment

## Overview

This environment simulates an e-commerce product management scenario where an AI agent needs to analyze sales data, identify low-selling products, categorize them for clearance, and send promotional emails to subscribers.

## Task Description

The agent needs to:
1. **Analyze Product Data**: Query WooCommerce for product sales data and inventory information
2. **Identify Low-Selling Products**: Find products that meet the criteria:
   - In stock for more than 90 days
   - Sales in last 30 days less than 10 units
3. **Categorize Products**: Move identified products to a "Clearance" category
4. **Send Notifications**: Email subscribers about the clearance sale with product details

## Environment Setup

### Initialization Parameters

- `task_dir`: Directory for task-related files (required)
- `num_low_selling`: Number of low-selling products to generate (default: 3)
- `num_normal_selling`: Number of normal-selling products to generate (default: 2)
- `num_subscribers`: Number of email subscribers (default: 2)
- `seed`: Random seed for reproducibility (default: 42)
- `difficulty`: Difficulty preset - "easy", "medium", "hard", "expert", "extreme", "insane"
- `verbose`: Whether to output to console (default: False)

### Difficulty Levels

- **Easy**: 3 low-selling, 2 normal, 2 subscribers
- **Medium**: 5 low-selling, 5 normal, 3 subscribers
- **Hard**: 10 low-selling, 15 normal, 5 subscribers
- **Expert**: 20 low-selling, 30 normal, 10 subscribers
- **Extreme**: 50 low-selling, 100 normal, 25 subscribers
- **Insane**: 100 low-selling, 200 normal, 50 subscribers

## Usage Example

```python
from gem.envs.filter_low_selling_products_s2l import FilterLowSellingProductsS2LEnv

# Create environment
env = FilterLowSellingProductsS2LEnv(
    task_dir="/path/to/task",
    num_low_selling=5,
    num_normal_selling=5,
    num_subscribers=3,
    seed=42,
    difficulty="medium",  # Optional: overrides individual parameters
    verbose=True
)

# Reset environment to initialize
instruction, info = env.reset()

# Agent executes task here...
# - Query WooCommerce for products
# - Analyze sales data
# - Move products to Clearance category
# - Send emails to subscribers

# Evaluate results
observation, reward, terminated, truncated, info = env.step("claim_done")
```

## Environment Structure

### Preprocessing (`reset()`)

1. Generates product data with specified number of low-selling and normal products
2. Generates subscriber information
3. Initializes WooCommerce database with products
4. Initializes Email database with user accounts
5. Copies initial workspace files (templates, credentials) to agent workspace
6. Generates groundtruth data for evaluation

### Evaluation (`step()`)

1. Checks WooCommerce database for product category changes
2. Verifies all low-selling products moved to "Clearance" category
3. Validates email notifications sent to all subscribers
4. Checks email content includes product information
5. Returns reward=1.0 if all checks pass, 0.0 otherwise

## Required MCP Servers

- **woocommerce-simplified**: For product and category management
- **emails-simplified**: For sending notification emails
- **filesystem**: For reading workspace files

## Required Local Tools

- **claim_done**: Signal task completion
- **python_execute**: Execute Python scripts for data processing
- **handle_overlong_tool_outputs**: Handle large tool outputs

## File Structure

```
filter_low_selling_products_s2l/
├── filter_low_selling_products_s2l.py  # Main environment class
├── __init__.py                          # Package initialization
├── README.md                            # This file
├── preprocess/                          # Preprocessing scripts
│   ├── main.py                          # Main preprocessing script
│   ├── generate_products_data.py        # Product data generation
│   ├── setup_test_products.py           # WooCommerce setup
│   └── filter.py                        # Filtering logic
├── evaluation/                          # Evaluation scripts
│   ├── main.py                          # Main evaluation script
│   └── check_remote.py                  # Remote/local DB checking
├── initial_workspace/                   # Template files
│   ├── admin_credentials.txt            # Admin account info
│   ├── blog_template.md                 # Blog post template
│   ├── email_template.txt               # Email template
│   └── subscriber.json                  # Subscriber list
└── emails_config.json                   # Email configuration

Task Directory (runtime):
task_dir/
├── agent_workspace/                     # Agent's working directory
│   ├── admin_credentials.txt
│   ├── blog_template.md
│   ├── email_template.txt
│   └── subscriber.json
├── local_db/                            # Local databases
│   ├── woocommerce/                     # WooCommerce data
│   └── emails/                          # Email data
├── groundtruth_workspace/               # Expected results
│   ├── generation_metadata.json         # Generation parameters
│   ├── expected_results.json            # Expected product list
│   └── clear_results.json               # Clearance products
└── logs/                                # Environment logs
    └── env.log
```

## Evaluation Criteria

### Product Categorization (50%)
- All low-selling products identified correctly
- Products moved to "Clearance" category in WooCommerce
- No false positives (normal products incorrectly categorized)

### Email Notifications (50%)
- Emails sent to all subscribers
- Email subject and content appropriate
- Product information included in emails
- Proper email format and structure

## Common Issues and Solutions

### Issue: Agent doesn't identify all low-selling products
**Solution**: Ensure agent queries WooCommerce for both `date_created` and `sales_last_30_days` metadata

### Issue: Products not moved to Clearance category
**Solution**: Check that agent creates "Clearance" category first if it doesn't exist, then updates product categories

### Issue: Emails not sent
**Solution**: Verify agent reads `subscriber.json` for email addresses and uses correct email server credentials from `admin_credentials.txt`

### Issue: Evaluation fails despite correct actions
**Solution**: Check logs in `task_dir/logs/env.log` for detailed error messages

## Dependencies

- Python 3.8+
- WooCommerce local database (via mcp_convert)
- Email local database (via mcp_convert)
- Standard Python libraries: json, datetime, pathlib

## Notes

- The environment uses local databases for both WooCommerce and Email, eliminating need for remote API access
- All generated files are stored in `task_dir`, not in the code directory, to support parallel execution
- Module names are uniquified using `id(self)` to prevent conflicts when multiple instances run simultaneously
- Preprocessing and evaluation run as subprocesses to avoid module import conflicts

