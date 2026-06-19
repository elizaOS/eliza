# WooCommerce MCP Server

A Model Context Protocol (MCP) server that provides WooCommerce REST API functionality using local JSON files as the database instead of connecting to external WooCommerce sites.

## Features

This server implements all major WooCommerce REST API endpoints:

### Products
- List, get, create, update, and delete products
- Batch product operations
- Product variations management
- Categories and tags
- Product reviews

### Orders
- List, get, create, update, and delete orders
- Batch order operations
- Order notes
- Refunds

### Customers
- List, get, create, and update customers
- Customer search

### Coupons
- List, get, create, update, and delete coupons
- Coupon filtering

### Shipping
- Shipping zones management
- Shipping methods

### Tax
- Tax rates and classes

### Reports
- Sales reports
- Top sellers
- Customer reports
- Stock reports
- Low stock reports

### System
- System status
- Settings management
- Payment gateways
- Webhooks

## Installation

```bash
# Install dependencies (if using the common MCP framework)
pip install -r requirements.txt
```

## Usage

### Initialize Database

```bash
python init_database.py --data-dir ./data
```

This will create a local database with demo data including:
- 3 sample products
- 2 sample orders
- 2 sample customers
- 2 sample coupons
- Shipping zones and methods
- Tax rates

### Run the Server

```bash
python server.py
```

### Use with Environment Variable

You can specify a custom data directory:

```bash
export WOOCOMMERCE_DATA_DIR=/path/to/data
python server.py
```

### Run Tests

```bash
python test_server.py
```

## Tool List

The server provides 53 tools matching the WooCommerce REST API:

### Product Tools (11)
- `woo_products_list` - List products with filters
- `woo_products_get` - Get specific product
- `woo_products_create` - Create new product
- `woo_products_update` - Update product
- `woo_products_delete` - Delete product
- `woo_products_batch_update` - Batch operations
- `woo_products_variations_list` - List variations
- `woo_products_categories_list` - List categories
- `woo_products_categories_create` - Create category
- `woo_products_tags_list` - List tags
- `woo_products_reviews_list` - List reviews

### Order Tools (9)
- `woo_orders_list` - List orders
- `woo_orders_get` - Get specific order
- `woo_orders_create` - Create order
- `woo_orders_update` - Update order
- `woo_orders_delete` - Delete order
- `woo_orders_batch_update` - Batch operations
- `woo_orders_notes_create` - Add order note
- `woo_orders_refunds_create` - Create refund

### Customer Tools (4)
- `woo_customers_list` - List customers
- `woo_customers_get` - Get specific customer
- `woo_customers_create` - Create customer
- `woo_customers_update` - Update customer

### Coupon Tools (5)
- `woo_coupons_list` - List coupons
- `woo_coupons_get` - Get specific coupon
- `woo_coupons_create` - Create coupon
- `woo_coupons_update` - Update coupon
- `woo_coupons_delete` - Delete coupon

### Report Tools (7)
- `woo_reports_sales` - Sales report
- `woo_reports_top_sellers` - Top sellers
- `woo_reports_customers` - Customer report
- `woo_reports_orders` - Orders report
- `woo_reports_products` - Products report
- `woo_reports_stock` - Stock report
- `woo_reports_low_stock` - Low stock report

### Shipping Tools (5)
- `woo_shipping_zones_list` - List zones
- `woo_shipping_zones_get` - Get zone
- `woo_shipping_zones_create` - Create zone
- `woo_shipping_zones_update` - Update zone
- `woo_shipping_zone_methods_list` - List methods
- `woo_shipping_zone_methods_create` - Add method

### Tax Tools (4)
- `woo_tax_rates_list` - List tax rates
- `woo_tax_rates_get` - Get tax rate
- `woo_tax_rates_create` - Create tax rate
- `woo_tax_classes_list` - List tax classes

### System Tools (8)
- `woo_system_status` - System status
- `woo_system_tools_list` - List system tools
- `woo_system_tools_run` - Run system tool
- `woo_settings_list` - List settings groups
- `woo_settings_get` - Get settings
- `woo_payment_gateways_list` - List gateways
- `woo_payment_gateways_get` - Get gateway
- `woo_payment_gateways_update` - Update gateway
- `woo_webhooks_list` - List webhooks
- `woo_webhooks_create` - Create webhook

## Data Structure

The local database stores data in JSON files:

```
data/
├── products.json          # Product catalog
├── categories.json        # Product categories
├── tags.json             # Product tags
├── reviews.json          # Product reviews
├── variations.json       # Product variations
├── orders.json           # Orders
├── order_notes.json      # Order notes
├── refunds.json          # Refunds
├── customers.json        # Customer data
├── coupons.json          # Coupon codes
├── shipping_zones.json   # Shipping zones
├── shipping_methods.json # Shipping methods
├── tax_rates.json        # Tax rates
├── tax_classes.json      # Tax classes
├── settings.json         # Settings
├── payment_gateways.json # Payment gateways
├── webhooks.json         # Webhooks
└── system_tools.json     # System tools
```

## Example Usage

### List Products

```python
# List all products
products = db.list_products()

# List with filters
products = db.list_products({
    "perPage": 10,
    "page": 1,
    "status": "publish",
    "featured": True,
    "onSale": True
})
```

### Create Order

```python
order = db.create_order({
    "customer_id": 1,
    "line_items": [
        {
            "product_id": 1,
            "quantity": 2,
            "price": 89.99
        }
    ],
    "billing": {
        "first_name": "John",
        "last_name": "Doe",
        "email": "john@example.com"
    }
})
```

### Generate Reports

```python
# Sales report
sales = db.get_sales_report({
    "dateMin": "2025-01-01",
    "dateMax": "2025-12-31"
})

# Top sellers
top_sellers = db.get_top_sellers_report({
    "perPage": 10
})
```

## Alignment with TypeScript Version



- ✅ All 53 tools with identical names
- ✅ Same input parameters and schemas
- ✅ Same output formats
- ✅ Same descriptions
- ✅ Compatible with extracted data samples

## Development

### Project Structure

```
mcps/woocommerce/
├── server.py           # Main MCP server implementation
├── database_utils.py   # Database operations
├── init_database.py    # Database initialization
├── test_server.py      # Test suite
├── README.md          # This file
└── data/              # Local database files
```

### Adding Custom Data

You can modify `init_database.py` to add custom demo data or use the database utility methods to populate data programmatically.

## License

This project follows the same license as the parent MCP project.
