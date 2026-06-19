# Evaluation Script Documentation

## Overview

The evaluation script is used to verify whether the Agent successfully completed the low-selling product filtering task, including:
1. Correctly identifying low-selling products (in stock >90 days AND 30-day sales <10)
2. Moving these products to the Outlet/Clearance category
3. Sending promotional emails containing the product list to all subscribers

## Major Updates (Supporting Dynamic Difficulty)

### New Features

1. **Groundtruth Metadata Integration**
   - Automatically reads `groundtruth_workspace/generation_metadata.json`
   - Displays generation parameters (number of products, number of subscribers, random seed, etc.)
   - Compares expected low-selling products with actually identified products

2. **Enhanced Debugging Information**
   - Displays expected low-selling product list
   - Compares expected vs actual, identifies differences
   - Provides more detailed diagnostic information

3. **Backward Compatibility**
   - If there is no groundtruth metadata, dynamic calculation is still used
   - Supports legacy hardcoded data format

## Usage

### Basic Usage

```bash
python evaluation/main.py \
  --agent_workspace /path/to/agent_workspace \
  --groundtruth_workspace /path/to/groundtruth_workspace
```

### Parameter Description

- `--agent_workspace` (required): Agent workspace path
- `--groundtruth_workspace` (optional): Groundtruth workspace path
  - If provided, reads `generation_metadata.json`
  - If not provided, uses pure dynamic evaluation
- `--res_log_file` (optional): Result log file path
- `--launch_time` (optional): Launch time

## Evaluation Process

### 1. Initialization

```
Low-Selling Products Filter Evaluation (Local Database)
============================================================

Database Directories:
   WooCommerce: /path/to/local_db/woocommerce
   Email: /path/to/local_db/emails

Loaded groundtruth metadata:
   - Low-selling products: 5
   - Normal-selling products: 5
   - Subscribers: 3
   - Total products: 10
   - Random seed: 42
```

### 2. Check WooCommerce & Email Services

#### Step A: Display Groundtruth Information

```
Groundtruth Metadata Information:
   Expected low-selling products: 5
   Expected normal products: 5
   Number of subscribers: 3

   Expected low-selling product list (5 total):
      1. Samsung Monitor v15
      2. LG Phone 2022
      3. Sony TV v8
      4. Xiaomi Tablet 2021
      5. Dell Laptop v3
```

#### Step B: Check Product Category Movement

```
Checking Product Categories and Movement...

Comparing expected vs actual low-selling products:
   Expected: 5
   Actually identified: 5
   Identification results match expectations exactly

Low-selling products sorted results (5 total):
============================================================
1. Samsung Monitor v15
   Days in stock: 245 days
   30-day sales: 2
   Original price: $199.99, Current price: $99.99
   Discount rate: 0.500 (50.0% off)
...

Found Outlet category: Outlet/Clearance
5/5 low-selling products have been moved to Outlet category
```

#### Step C: Check Email Sending

```
Checking email sending...
Found 5 low-selling products for promotion
Need to check emails for 3 subscribers

Starting to check sent emails for all users...
   Found matching email sent to john@mcpt.com
   Found matching email sent to mike@mcpt.com
   Found matching email sent to tom@mcpt.com

3/3 subscribers received correct promotional emails
```

### 3. Evaluation Summary

```
============================================================
EVALUATION SUMMARY
============================================================
WooCommerce & Email Services: PASSED

Overall: 1/1 tests passed - ALL TESTS PASSED!

Low-selling products filter evaluation completed successfully!

Successfully filtered low-selling products from WooCommerce
Successfully sent notification email with product list
```

## Evaluation Criteria

### Product Categories Check

**Pass Conditions:**
- Outlet/Clearance category exists
- All low-selling products (in stock >90 days AND 30-day sales <10) have been moved to this category
- No normal-selling products were incorrectly moved to this category

**Judgment Logic:**
```python
# Low-selling product condition
days_in_stock > 90 and sales_30_days < 10
```

### Email Sending Check

**Pass Conditions:**
- All subscribers received the email
- Email content contains all low-selling products
- Product information format is correct (name - original price - promotional price)
- Product order is correct (by stock date from earliest to latest, discount rate from smallest to largest)

**Email Content Format:**
```
Product Name 1 - Original Price: $XX.XX - Promotional Price: $YY.YY
Product Name 2 - Original Price: $XX.XX - Promotional Price: $YY.YY
...
```

## Groundtruth Metadata Format

`groundtruth_workspace/generation_metadata.json`:

```json
{
  "generation_params": {
    "num_low_selling": 5,
    "num_normal_selling": 5,
    "num_subscribers": 3,
    "seed": 42,
    "total_products": 10
  },
  "low_selling_products": [
    "Samsung Monitor v15",
    "LG Phone 2022",
    ...
  ],
  "normal_selling_products": [
    "Dell Laptop 2025",
    ...
  ],
  "subscribers": [
    "john@mcpt.com",
    "mike@mcpt.com",
    ...
  ],
  "timestamp": "2025-01-01T10:00:00"
}
```

## Comparison Feature

### Expected vs Actual

The evaluation script compares:
1. **Expected low-selling products** (from generation_metadata.json)
2. **Actually identified low-selling products** (dynamically calculated from database)

If inconsistent, it will display:
- Missing products (expected but not identified)
- Extra products (identified but not expected)

**Note:** If product data is modified during task execution (such as sales or date changes), differences may occur.

## Error Handling

### Common Error Scenarios

1. **Outlet/Clearance category not found**
   ```
   Outlet/Clearance category not found
   ```
   -> Agent needs to create this category

2. **Low-selling products not moved**
   ```
   Only 3/5 low-selling products are in the Outlet category
   Products not moved: ['Product A', 'Product B']
   ```
   -> Agent needs to move all low-selling products

3. **Normal products incorrectly moved**
   ```
   Found 2 products that should not be in the Outlet category
   ```
   -> Agent incorrectly identified products

4. **Email not sent or content incorrect**
   ```
   0/3 subscribers received correct promotional emails
   ```
   -> Agent needs to send emails to all subscribers

## Debugging Suggestions

### 1. View Groundtruth Metadata

```bash
cat groundtruth_workspace/generation_metadata.json | python -m json.tool
```

### 2. Check Database Status

```python
from mcps.woocommerce.database_utils import WooCommerceDatabase
db = WooCommerceDatabase(data_dir="/path/to/local_db/woocommerce")

# View all products
products = db.list_products()
print(f"Total products: {len(products)}")

# View categories
categories = list(db.categories.values())
for cat in categories:
    print(f"{cat['name']}: {cat['id']}")
```

### 3. Check Email Database

```python
from mcps.email.database_utils import EmailDatabase
db = EmailDatabase(data_dir="/path/to/local_db/emails")

# View all users
print(f"Users: {list(db.users.keys())}")

# View a user's emails
emails = db.list_emails("admin@woocommerce.local")
print(f"Sent emails: {len([e for e in emails if e.get('folder') == 'Sent'])}")
```

## Version Compatibility

### Supported Modes

1. **New Version (Recommended)**: Using dynamically generated data + Groundtruth metadata
   - Complete comparison feature
   - Detailed debugging information
   - Traceable generation parameters

2. **Legacy Version (Compatible)**: Using hardcoded data
   - Pure dynamic calculation
   - No metadata comparison
   - No generation parameter information

## Output Files

The evaluation script does not generate output files; all results are output to the console.

It is recommended to redirect output to save logs:

```bash
python evaluation/main.py \
  --agent_workspace /path/to/workspace \
  --groundtruth_workspace /path/to/groundtruth \
  2>&1 | tee evaluation_log.txt
```

## Exit Codes

- `0`: Evaluation passed
- `1`: Evaluation failed or error occurred




