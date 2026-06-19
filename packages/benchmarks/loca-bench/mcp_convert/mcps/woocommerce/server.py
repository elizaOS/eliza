#!/usr/bin/env python3
"""
WooCommerce MCP Server

A Model Context Protocol server that provides WooCommerce REST API functionality
using local JSON files as the database instead of connecting to external APIs.

Uses the common MCP framework for simplified development.
"""

import asyncio
import sys
import os

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry
from mcps.woocommerce.database_utils import WooCommerceDatabase


class WooCommerceMCPServer(BaseMCPServer):
    """WooCommerce MCP server implementation"""
    
    def __init__(self):
        super().__init__("woocommerce", "1.0.6")
        
        # Get data directory from environment variable or use default
        data_dir = os.environ.get('WOOCOMMERCE_DATA_DIR')
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if data_dir:
            if not quiet:
                print(f"Using WooCommerce data directory from environment: {data_dir}", file=sys.stderr)
            os.makedirs(data_dir, exist_ok=True)
        else:
            # Use default data directory if not specified
            data_dir = os.path.join(os.path.dirname(__file__), "data")
            if not quiet:
                print(f"Using default WooCommerce data directory: {data_dir}", file=sys.stderr)
        
        self.db = WooCommerceDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.setup_tools()
    
    def setup_tools(self):
        """Setup all WooCommerce tools"""
        
        # ==================== Product Tools ====================
        
        self.tool_registry.register(
            name="woo_products_list",
            description="List products with optional filters. IMPORTANT: Use perPage parameter to control how many results to return (default is 10, max is 100). Use page parameter for pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items to return per page (default: 10, max: 100). Always specify this to control result size."},
                    "page": {"type": "integer", "description": "Page number for pagination (default: 1). Use with perPage to navigate through results."},
                    "search": {"type": "string", "description": "Search term"},
                    "status": {"type": "string", "description": "Product status", "enum": ["publish", "draft", "private", "pending"]},
                    "category": {"type": "string", "description": "Category ID"},
                    "tag": {"type": "string", "description": "Tag ID"},
                    "sku": {"type": "string", "description": "Product SKU"},
                    "featured": {"type": "boolean", "description": "Featured products only"},
                    "onSale": {"type": "boolean", "description": "On sale products only"},
                    "minPrice": {"type": "string", "description": "Minimum price"},
                    "maxPrice": {"type": "string", "description": "Maximum price"},
                    "stockStatus": {"type": "string", "description": "Stock status", "enum": ["instock", "outofstock", "onbackorder"]},
                    "orderby": {"type": "string", "description": "Order by field", "enum": ["date", "id", "include", "title", "slug", "price", "popularity", "rating"]},
                    "order": {"type": "string", "description": "Order direction", "enum": ["asc", "desc"]}
                }
            },
            handler=self.woo_products_list
        )
        
        self.tool_registry.register(
            name="woo_products_get",
            description="Get a specific product by ID",
            input_schema={
                "type": "object",
                "properties": {
                    "productId": {"type": "integer", "description": "Product ID"}
                },
                "required": ["productId"]
            },
            handler=self.woo_products_get
        )
        
        self.tool_registry.register(
            name="woo_products_create",
            description="Create a new product",
            input_schema={
                "type": "object",
                "properties": {
                    "productData": {
                        "type": "object",
                        "description": "Product data",
                        "properties": {
                            "name": {"type": "string", "description": "Product name"},
                            "type": {"type": "string", "description": "Product type", "enum": ["simple", "grouped", "external", "variable"]},
                            "status": {"type": "string", "description": "Product status", "enum": ["publish", "draft", "private", "pending"]},
                            "featured": {"type": "boolean", "description": "Featured product"},
                            "catalog_visibility": {"type": "string", "description": "Catalog visibility", "enum": ["visible", "catalog", "search", "hidden"]},
                            "description": {"type": "string", "description": "Product description"},
                            "short_description": {"type": "string", "description": "Product short description"},
                            "sku": {"type": "string", "description": "Product SKU"},
                            "regular_price": {"type": "string", "description": "Regular price"},
                            "sale_price": {"type": "string", "description": "Sale price"},
                            "manage_stock": {"type": "boolean", "description": "Manage stock"},
                            "stock_quantity": {"type": "integer", "description": "Stock quantity"},
                            "categories": {
                                "type": "array",
                                "description": "Product categories",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": {"type": "integer", "description": "Category ID"}
                                    }
                                }
                            },
                            "images": {
                                "type": "array",
                                "description": "Product images",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "src": {"type": "string", "description": "Image URL"},
                                        "alt": {"type": "string", "description": "Image alt text"}
                                    }
                                }
                            }
                        }
                    }
                },
                "required": ["productData"]
            },
            handler=self.woo_products_create
        )
        
        self.tool_registry.register(
            name="woo_products_update",
            description="Update a product",
            input_schema={
                "type": "object",
                "properties": {
                    "productId": {"type": "integer", "description": "Product ID"},
                    "productData": {
                        "type": "object",
                        "description": "Product data to update"
                    }
                },
                "required": ["productId", "productData"]
            },
            handler=self.woo_products_update
        )
        
        self.tool_registry.register(
            name="woo_products_delete",
            description="Delete a product",
            input_schema={
                "type": "object",
                "properties": {
                    "productId": {"type": "integer", "description": "Product ID"},
                    "force": {"type": "boolean", "description": "Force delete", "default": False}
                },
                "required": ["productId"]
            },
            handler=self.woo_products_delete
        )
        
        self.tool_registry.register(
            name="woo_products_batch_update",
            description="Batch update products",
            input_schema={
                "type": "object",
                "properties": {
                    "create": {
                        "type": "array",
                        "description": "Products to create",
                        "items": {"type": "object"}
                    },
                    "update": {
                        "type": "array",
                        "description": "Products to update",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer", "description": "Product ID"}
                            }
                        }
                    },
                    "delete": {
                        "type": "array",
                        "description": "Product IDs to delete",
                        "items": {"type": "integer"}
                    }
                }
            },
            handler=self.woo_products_batch_update
        )
        
        self.tool_registry.register(
            name="woo_products_variations_list",
            description="List product variations. Use perPage and page parameters for pagination (default: 10 items per page).",
            input_schema={
                "type": "object",
                "properties": {
                    "productId": {"type": "integer", "description": "Product ID"},
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"}
                },
                "required": ["productId"]
            },
            handler=self.woo_products_variations_list
        )
        
        self.tool_registry.register(
            name="woo_products_categories_list",
            description="List product categories. Use perPage and page parameters for pagination (default: 10 items per page).",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"},
                    "search": {"type": "string", "description": "Search term"},
                    "parent": {"type": "integer", "description": "Parent category ID"},
                    "hideEmpty": {"type": "boolean", "description": "Hide empty categories"}
                }
            },
            handler=self.woo_products_categories_list
        )
        
        self.tool_registry.register(
            name="woo_products_categories_create",
            description="Create a new product category",
            input_schema={
                "type": "object",
                "properties": {
                    "categoryData": {
                        "type": "object",
                        "required": ["name"],
                        "properties": {
                            "name": {"type": "string", "description": "Category name"},
                            "slug": {"type": "string", "description": "Category slug"},
                            "parent": {"type": "integer", "description": "Parent category ID"},
                            "description": {"type": "string", "description": "Category description"},
                            "display": {
                                "type": "string",
                                "description": "Display type",
                                "enum": ["default", "products", "subcategories", "both"]
                            },
                            "image": {
                                "type": "object",
                                "properties": {
                                    "src": {"type": "string", "description": "Image URL"},
                                    "alt": {"type": "string", "description": "Image alt text"}
                                }
                            },
                            "menuOrder": {"type": "integer", "description": "Menu order"}
                        }
                    }
                },
                "required": ["categoryData"]
            },
            handler=self.woo_products_categories_create
        )
        
        self.tool_registry.register(
            name="woo_products_tags_list",
            description="List product tags. Use perPage and page parameters for pagination (default: 10 items per page).",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"},
                    "search": {"type": "string", "description": "Search term"},
                    "hideEmpty": {"type": "boolean", "description": "Hide empty tags"}
                }
            },
            handler=self.woo_products_tags_list
        )
        
        self.tool_registry.register(
            name="woo_products_reviews_list",
            description="List product reviews. Use perPage and page parameters for pagination (default: 10 items per page).",
            input_schema={
                "type": "object",
                "properties": {
                    "productId": {"type": "integer", "description": "Product ID (optional)"},
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"},
                    "status": {"type": "string", "description": "Review status", "enum": ["all", "hold", "approved", "spam", "trash"]}
                }
            },
            handler=self.woo_products_reviews_list
        )
        
        # ==================== Order Tools ====================
        
        self.tool_registry.register(
            name="woo_orders_list",
            description="List orders with optional filters. IMPORTANT: Use perPage parameter to control how many results to return (default is 10, max is 100). Use page parameter for pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items to return per page (default: 10, max: 100). Always specify this to control result size."},
                    "page": {"type": "integer", "description": "Page number for pagination (default: 1). Use with perPage to navigate through results."},
                    "status": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]},
                        "description": "Order statuses"
                    },
                    "customer": {"type": "integer", "description": "Customer ID"},
                    "product": {"type": "integer", "description": "Product ID"},
                    "dateAfter": {"type": "string", "description": "Orders after this date (ISO 8601)"},
                    "dateBefore": {"type": "string", "description": "Orders before this date (ISO 8601)"},
                    "orderby": {"type": "string", "description": "Order by field", "enum": ["date", "id", "include", "title", "slug"]},
                    "order": {"type": "string", "description": "Order direction", "enum": ["asc", "desc"]}
                }
            },
            handler=self.woo_orders_list
        )
        
        self.tool_registry.register(
            name="woo_orders_get",
            description="Get a specific order by ID",
            input_schema={
                "type": "object",
                "properties": {
                    "orderId": {"type": "integer", "description": "Order ID"}
                },
                "required": ["orderId"]
            },
            handler=self.woo_orders_get
        )
        
        self.tool_registry.register(
            name="woo_orders_create",
            description="Create a new order",
            input_schema={
                "type": "object",
                "properties": {
                    "orderData": {
                        "type": "object",
                        "description": "Order data",
                        "properties": {
                            "payment_method": {"type": "string", "description": "Payment method ID"},
                            "payment_method_title": {"type": "string", "description": "Payment method title"},
                            "set_paid": {"type": "boolean", "description": "Define if the order is paid"},
                            "billing": {
                                "type": "object",
                                "description": "Billing address"
                            },
                            "shipping": {
                                "type": "object",
                                "description": "Shipping address"
                            },
                            "line_items": {
                                "type": "array",
                                "description": "Line items data",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "product_id": {"type": "integer", "description": "Product ID"},
                                        "quantity": {"type": "integer", "description": "Quantity"}
                                    }
                                }
                            },
                            "shipping_lines": {
                                "type": "array",
                                "description": "Shipping lines data",
                                "items": {"type": "object"}
                            }
                        }
                    }
                },
                "required": ["orderData"]
            },
            handler=self.woo_orders_create
        )
        
        self.tool_registry.register(
            name="woo_orders_update",
            description="Update an order",
            input_schema={
                "type": "object",
                "properties": {
                    "orderId": {"type": "integer", "description": "Order ID"},
                    "orderData": {
                        "type": "object",
                        "description": "Order data to update"
                    }
                },
                "required": ["orderId", "orderData"]
            },
            handler=self.woo_orders_update
        )
        
        self.tool_registry.register(
            name="woo_orders_delete",
            description="Delete an order",
            input_schema={
                "type": "object",
                "properties": {
                    "orderId": {"type": "integer", "description": "Order ID"},
                    "force": {"type": "boolean", "description": "Force delete", "default": False}
                },
                "required": ["orderId"]
            },
            handler=self.woo_orders_delete
        )
        
        self.tool_registry.register(
            name="woo_orders_batch_update",
            description="Batch update orders",
            input_schema={
                "type": "object",
                "properties": {
                    "create": {
                        "type": "array",
                        "description": "Orders to create",
                        "items": {"type": "object"}
                    },
                    "update": {
                        "type": "array",
                        "description": "Orders to update",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer", "description": "Order ID"}
                            }
                        }
                    },
                    "delete": {
                        "type": "array",
                        "description": "Order IDs to delete",
                        "items": {"type": "integer"}
                    }
                }
            },
            handler=self.woo_orders_batch_update
        )
        
        self.tool_registry.register(
            name="woo_orders_notes_create",
            description="Add a note to an order",
            input_schema={
                "type": "object",
                "properties": {
                    "orderId": {"type": "integer", "description": "Order ID"},
                    "note": {"type": "string", "description": "Note content"},
                    "customerNote": {"type": "boolean", "description": "Is customer note", "default": False}
                },
                "required": ["orderId", "note"]
            },
            handler=self.woo_orders_notes_create
        )
        
        self.tool_registry.register(
            name="woo_orders_refunds_create",
            description="Create a refund for an order",
            input_schema={
                "type": "object",
                "properties": {
                    "orderId": {"type": "integer", "description": "Order ID"},
                    "amount": {"type": "string", "description": "Refund amount"},
                    "reason": {"type": "string", "description": "Refund reason"},
                    "refundPayment": {"type": "boolean", "description": "Refund payment", "default": False},
                    "lineItems": {
                        "type": "array",
                        "description": "Line items to refund",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer", "description": "Line item ID"},
                                "refund_total": {"type": "number", "description": "Amount to refund"},
                                "refund_tax": {
                                    "type": "array",
                                    "description": "Tax to refund",
                                    "items": {"type": "object"}
                                }
                            }
                        }
                    }
                },
                "required": ["orderId"]
            },
            handler=self.woo_orders_refunds_create
        )
        
        # ==================== Customer Tools ====================
        
        self.tool_registry.register(
            name="woo_customers_list",
            description="List customers with optional filters. IMPORTANT: Use perPage parameter to control how many results to return (default is 10, max is 100). Use page parameter for pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items to return per page (default: 10, max: 100). Always specify this to control result size."},
                    "page": {"type": "integer", "description": "Page number for pagination (default: 1). Use with perPage to navigate through results."},
                    "search": {"type": "string", "description": "Search term"},
                    "email": {"type": "string", "description": "Customer email"},
                    "role": {"type": "string", "description": "Customer role", "enum": ["all", "customer", "administrator", "shop_manager"]},
                    "orderby": {"type": "string", "description": "Order by field", "enum": ["id", "include", "name", "registered_date"]},
                    "order": {"type": "string", "description": "Order direction", "enum": ["asc", "desc"]}
                }
            },
            handler=self.woo_customers_list
        )
        
        self.tool_registry.register(
            name="woo_customers_get",
            description="Get a specific customer by ID",
            input_schema={
                "type": "object",
                "properties": {
                    "customerId": {"type": "integer", "description": "Customer ID"}
                },
                "required": ["customerId"]
            },
            handler=self.woo_customers_get
        )
        
        self.tool_registry.register(
            name="woo_customers_create",
            description="Create a new customer",
            input_schema={
                "type": "object",
                "properties": {
                    "customerData": {
                        "type": "object",
                        "description": "Customer data",
                        "properties": {
                            "email": {"type": "string", "description": "Customer email"},
                            "first_name": {"type": "string", "description": "First name"},
                            "last_name": {"type": "string", "description": "Last name"},
                            "username": {"type": "string", "description": "Username"},
                            "password": {"type": "string", "description": "Password"},
                            "billing": {
                                "type": "object",
                                "description": "Billing address"
                            },
                            "shipping": {
                                "type": "object",
                                "description": "Shipping address"
                            },
                            "meta_data": {
                                "type": "array",
                                "description": "Meta data",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "key": {"type": "string"},
                                        "value": {"type": "string"}
                                    }
                                }
                            }
                        }
                    }
                },
                "required": ["customerData"]
            },
            handler=self.woo_customers_create
        )
        
        self.tool_registry.register(
            name="woo_customers_update",
            description="Update a customer",
            input_schema={
                "type": "object",
                "properties": {
                    "customerId": {"type": "integer", "description": "Customer ID"},
                    "customerData": {
                        "type": "object",
                        "description": "Customer data to update"
                    }
                },
                "required": ["customerId", "customerData"]
            },
            handler=self.woo_customers_update
        )
        
        # ==================== Coupon Tools ====================
        
        self.tool_registry.register(
            name="woo_coupons_list",
            description="List coupons with optional filters. IMPORTANT: Use perPage parameter to control how many results to return (default is 10, max is 100). Use page parameter for pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items to return per page (default: 10, max: 100). Always specify this to control result size."},
                    "page": {"type": "integer", "description": "Page number for pagination (default: 1). Use with perPage to navigate through results."},
                    "search": {"type": "string", "description": "Search term"},
                    "code": {"type": "string", "description": "Coupon code"}
                }
            },
            handler=self.woo_coupons_list
        )
        
        self.tool_registry.register(
            name="woo_coupons_get",
            description="Get a specific coupon by ID",
            input_schema={
                "type": "object",
                "properties": {
                    "couponId": {"type": "integer", "description": "Coupon ID"}
                },
                "required": ["couponId"]
            },
            handler=self.woo_coupons_get
        )
        
        self.tool_registry.register(
            name="woo_coupons_create",
            description="Create a new coupon",
            input_schema={
                "type": "object",
                "properties": {
                    "couponData": {
                        "type": "object",
                        "description": "Coupon data",
                        "properties": {
                            "code": {"type": "string", "description": "Coupon code"},
                            "discount_type": {"type": "string", "description": "Discount type", "enum": ["percent", "fixed_cart", "fixed_product"]},
                            "amount": {"type": "string", "description": "Discount amount"},
                            "date_expires": {"type": "string", "description": "Expiry date (ISO 8601)"},
                            "individual_use": {"type": "boolean", "description": "Individual use only"},
                            "product_ids": {
                                "type": "array",
                                "description": "Product IDs",
                                "items": {"type": "integer"}
                            },
                            "excluded_product_ids": {
                                "type": "array",
                                "description": "Excluded product IDs",
                                "items": {"type": "integer"}
                            },
                            "usage_limit": {"type": "integer", "description": "Usage limit per coupon"},
                            "usage_limit_per_user": {"type": "integer", "description": "Usage limit per user"},
                            "limit_usage_to_x_items": {"type": "integer", "description": "Limit usage to X items"},
                            "free_shipping": {"type": "boolean", "description": "Allow free shipping"},
                            "exclude_sale_items": {"type": "boolean", "description": "Exclude sale items"},
                            "minimum_amount": {"type": "string", "description": "Minimum spend"},
                            "maximum_amount": {"type": "string", "description": "Maximum spend"}
                        },
                        "required": ["code", "discount_type", "amount"]
                    }
                },
                "required": ["couponData"]
            },
            handler=self.woo_coupons_create
        )
        
        self.tool_registry.register(
            name="woo_coupons_update",
            description="Update a coupon",
            input_schema={
                "type": "object",
                "properties": {
                    "couponId": {"type": "integer", "description": "Coupon ID"},
                    "couponData": {
                        "type": "object",
                        "description": "Coupon data to update"
                    }
                },
                "required": ["couponId", "couponData"]
            },
            handler=self.woo_coupons_update
        )
        
        self.tool_registry.register(
            name="woo_coupons_delete",
            description="Delete a coupon",
            input_schema={
                "type": "object",
                "properties": {
                    "couponId": {"type": "integer", "description": "Coupon ID"},
                    "force": {"type": "boolean", "description": "Force delete", "default": True}
                },
                "required": ["couponId"]
            },
            handler=self.woo_coupons_delete
        )
        
        # ==================== Report Tools ====================
        
        self.tool_registry.register(
            name="woo_reports_sales",
            description="Get sales report",
            input_schema={
                "type": "object",
                "properties": {
                    "period": {"type": "string", "description": "Report period", "enum": ["week", "month", "last_month", "year"]},
                    "dateMin": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                    "dateMax": {"type": "string", "description": "End date (YYYY-MM-DD)"}
                }
            },
            handler=self.woo_reports_sales
        )
        
        self.tool_registry.register(
            name="woo_reports_top_sellers",
            description="Get top sellers report. Use perPage and page parameters to control pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "period": {"type": "string", "description": "Report period", "enum": ["week", "month", "last_month", "year"]},
                    "dateMin": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                    "dateMax": {"type": "string", "description": "End date (YYYY-MM-DD)"},
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"}
                }
            },
            handler=self.woo_reports_top_sellers
        )
        
        self.tool_registry.register(
            name="woo_reports_customers",
            description="Get customers report",
            input_schema={
                "type": "object",
                "properties": {
                    "period": {"type": "string", "description": "Report period", "enum": ["week", "month", "last_month", "year"]},
                    "dateMin": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                    "dateMax": {"type": "string", "description": "End date (YYYY-MM-DD)"}
                }
            },
            handler=self.woo_reports_customers
        )
        
        self.tool_registry.register(
            name="woo_reports_orders",
            description="Get orders report",
            input_schema={
                "type": "object",
                "properties": {
                    "period": {"type": "string", "description": "Report period", "enum": ["week", "month", "last_month", "year"]},
                    "dateMin": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                    "dateMax": {"type": "string", "description": "End date (YYYY-MM-DD)"}
                }
            },
            handler=self.woo_reports_orders
        )
        
        self.tool_registry.register(
            name="woo_reports_products",
            description="Get products report. Use perPage and page parameters to control pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "period": {"type": "string", "description": "Report period", "enum": ["week", "month", "last_month", "year"]},
                    "dateMin": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                    "dateMax": {"type": "string", "description": "End date (YYYY-MM-DD)"},
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"}
                }
            },
            handler=self.woo_reports_products
        )
        
        self.tool_registry.register(
            name="woo_reports_stock",
            description="Get stock report. Use perPage and page parameters to control pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"}
                }
            },
            handler=self.woo_reports_stock
        )
        
        self.tool_registry.register(
            name="woo_reports_low_stock",
            description="Get low stock report. Use perPage and page parameters to control pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"}
                }
            },
            handler=self.woo_reports_low_stock
        )
        
        # ==================== Shipping Tools ====================
        
        self.tool_registry.register(
            name="woo_shipping_zones_list",
            description="List shipping zones",
            input_schema={"type": "object", "properties": {}},
            handler=self.woo_shipping_zones_list
        )
        
        self.tool_registry.register(
            name="woo_shipping_zones_get",
            description="Get a shipping zone",
            input_schema={
                "type": "object",
                "properties": {
                    "zoneId": {"type": "integer", "description": "Zone ID"}
                },
                "required": ["zoneId"]
            },
            handler=self.woo_shipping_zones_get
        )
        
        self.tool_registry.register(
            name="woo_shipping_zones_create",
            description="Create a shipping zone",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Zone name"},
                    "order": {"type": "integer", "description": "Zone order"}
                },
                "required": ["name"]
            },
            handler=self.woo_shipping_zones_create
        )
        
        self.tool_registry.register(
            name="woo_shipping_zones_update",
            description="Update a shipping zone",
            input_schema={
                "type": "object",
                "properties": {
                    "zoneId": {"type": "integer", "description": "Zone ID"},
                    "name": {"type": "string", "description": "Zone name"},
                    "order": {"type": "integer", "description": "Zone order"}
                },
                "required": ["zoneId"]
            },
            handler=self.woo_shipping_zones_update
        )
        
        self.tool_registry.register(
            name="woo_shipping_zone_methods_list",
            description="List methods for a shipping zone",
            input_schema={
                "type": "object",
                "properties": {
                    "zoneId": {"type": "integer", "description": "Zone ID"}
                },
                "required": ["zoneId"]
            },
            handler=self.woo_shipping_zone_methods_list
        )
        
        self.tool_registry.register(
            name="woo_shipping_zone_methods_create",
            description="Add a method to a shipping zone",
            input_schema={
                "type": "object",
                "properties": {
                    "zoneId": {"type": "integer", "description": "Zone ID"},
                    "methodId": {"type": "string", "description": "Method ID"},
                    "enabled": {"type": "boolean", "description": "Is enabled", "default": True},
                    "settings": {
                        "type": "object",
                        "description": "Method settings"
                    }
                },
                "required": ["zoneId", "methodId"]
            },
            handler=self.woo_shipping_zone_methods_create
        )
        
        # ==================== Tax Tools ====================
        
        self.tool_registry.register(
            name="woo_tax_rates_list",
            description="List tax rates. Use perPage and page parameters to control pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "taxClass": {"type": "string", "description": "Tax class"},
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"}
                }
            },
            handler=self.woo_tax_rates_list
        )
        
        self.tool_registry.register(
            name="woo_tax_rates_get",
            description="Get a tax rate",
            input_schema={
                "type": "object",
                "properties": {
                    "rateId": {"type": "integer", "description": "Tax rate ID"}
                },
                "required": ["rateId"]
            },
            handler=self.woo_tax_rates_get
        )
        
        self.tool_registry.register(
            name="woo_tax_rates_create",
            description="Create a tax rate",
            input_schema={
                "type": "object",
                "properties": {
                    "country": {"type": "string", "description": "Country code"},
                    "state": {"type": "string", "description": "State code"},
                    "rate": {"type": "string", "description": "Tax rate"},
                    "name": {"type": "string", "description": "Tax name"},
                    "priority": {"type": "integer", "description": "Priority", "default": 1},
                    "compound": {"type": "boolean", "description": "Is compound", "default": False},
                    "shipping": {"type": "boolean", "description": "Apply to shipping", "default": True},
                    "class": {"type": "string", "description": "Tax class", "default": "standard"}
                },
                "required": ["country", "rate"]
            },
            handler=self.woo_tax_rates_create
        )
        
        self.tool_registry.register(
            name="woo_tax_classes_list",
            description="List tax classes",
            input_schema={"type": "object", "properties": {}},
            handler=self.woo_tax_classes_list
        )
        
        # ==================== System Tools ====================
        
        self.tool_registry.register(
            name="woo_system_status",
            description="Get system status information",
            input_schema={"type": "object", "properties": {}},
            handler=self.woo_system_status
        )
        
        self.tool_registry.register(
            name="woo_system_tools_list",
            description="List system tools",
            input_schema={"type": "object", "properties": {}},
            handler=self.woo_system_tools_list
        )
        
        self.tool_registry.register(
            name="woo_system_tools_run",
            description="Run a system tool",
            input_schema={
                "type": "object",
                "properties": {
                    "toolId": {
                        "type": "string",
                        "description": "Tool ID",
                        "enum": ["clear_transients", "clear_expired_transients", "clear_orphaned_variations", "add_order_indexes", "recount_terms", "reset_roles", "clear_sessions", "clear_template_cache", "clear_system_status_theme_info_cache"]
                    }
                },
                "required": ["toolId"]
            },
            handler=self.woo_system_tools_run
        )
        
        self.tool_registry.register(
            name="woo_settings_list",
            description="List settings groups",
            input_schema={"type": "object", "properties": {}},
            handler=self.woo_settings_list
        )
        
        self.tool_registry.register(
            name="woo_settings_get",
            description="Get settings for a group",
            input_schema={
                "type": "object",
                "properties": {
                    "groupId": {
                        "type": "string",
                        "description": "Settings group ID",
                        "enum": ["general", "products", "tax", "shipping", "checkout", "account", "email", "integration", "advanced", "rest-api"]
                    }
                },
                "required": ["groupId"]
            },
            handler=self.woo_settings_get
        )
        
        self.tool_registry.register(
            name="woo_payment_gateways_list",
            description="List payment gateways",
            input_schema={"type": "object", "properties": {}},
            handler=self.woo_payment_gateways_list
        )
        
        self.tool_registry.register(
            name="woo_payment_gateways_get",
            description="Get a payment gateway",
            input_schema={
                "type": "object",
                "properties": {
                    "gatewayId": {"type": "string", "description": "Gateway ID"}
                },
                "required": ["gatewayId"]
            },
            handler=self.woo_payment_gateways_get
        )
        
        self.tool_registry.register(
            name="woo_payment_gateways_update",
            description="Update a payment gateway",
            input_schema={
                "type": "object",
                "properties": {
                    "gatewayId": {"type": "string", "description": "Gateway ID"},
                    "enabled": {"type": "boolean", "description": "Is enabled"},
                    "title": {"type": "string", "description": "Gateway title"},
                    "description": {"type": "string", "description": "Gateway description"},
                    "settings": {
                        "type": "object",
                        "description": "Gateway settings"
                    }
                },
                "required": ["gatewayId"]
            },
            handler=self.woo_payment_gateways_update
        )
        
        self.tool_registry.register(
            name="woo_webhooks_list",
            description="List webhooks. Use perPage and page parameters to control pagination.",
            input_schema={
                "type": "object",
                "properties": {
                    "perPage": {"type": "integer", "description": "Number of items per page (default: 10, max: 100)"},
                    "page": {"type": "integer", "description": "Page number (default: 1)"},
                    "status": {"type": "string", "description": "Webhook status", "enum": ["active", "paused", "disabled"]}
                }
            },
            handler=self.woo_webhooks_list
        )
        
        self.tool_registry.register(
            name="woo_webhooks_create",
            description="Create a webhook",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Webhook name"},
                    "topic": {
                        "type": "string",
                        "description": "Webhook topic",
                        "enum": ["coupon.created", "coupon.updated", "coupon.deleted", "customer.created", "customer.updated", "customer.deleted", "order.created", "order.updated", "order.deleted", "product.created", "product.updated", "product.deleted"]
                    },
                    "delivery_url": {"type": "string", "description": "Delivery URL"},
                    "status": {"type": "string", "description": "Webhook status", "enum": ["active", "paused", "disabled"], "default": "active"},
                    "secret": {"type": "string", "description": "Secret key"}
                },
                "required": ["name", "topic", "delivery_url"]
            },
            handler=self.woo_webhooks_create
        )
    
    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()
    
    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)
    
    # ==================== Tool Handlers - Products ====================
    
    async def woo_products_list(self, args: dict):
        """List products"""
        try:
            products = self.db.list_products(args)
            return self.create_json_response(products)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_get(self, args: dict):
        """Get a product"""
        try:
            product = self.db.get_product(args['productId'])
            if not product:
                return self.create_error_response(f"Product {args['productId']} not found")
            return self.create_json_response(product)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_create(self, args: dict):
        """Create a product"""
        try:
            product = self.db.create_product(args['productData'])
            return self.create_json_response(product)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_update(self, args: dict):
        """Update a product"""
        try:
            product = self.db.update_product(args['productId'], args['productData'])
            return self.create_json_response(product)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_delete(self, args: dict):
        """Delete a product"""
        try:
            force = args.get('force', False)
            product = self.db.delete_product(args['productId'], force)
            return self.create_json_response(product)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_batch_update(self, args: dict):
        """Batch update products"""
        try:
            result = self.db.batch_update_products(args)
            return self.create_json_response(result)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_variations_list(self, args: dict):
        """List product variations"""
        try:
            per_page = args.get('perPage', 10)
            page = args.get('page', 1)
            variations = self.db.list_variations(args['productId'], per_page, page)
            return self.create_json_response(variations)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_categories_list(self, args: dict):
        """List categories"""
        try:
            categories = self.db.list_categories(args)
            return self.create_json_response(categories)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_categories_create(self, args: dict):
        """Create a category"""
        try:
            category = self.db.create_category(args['categoryData'])
            return self.create_json_response(category)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_tags_list(self, args: dict):
        """List tags"""
        try:
            tags = self.db.list_tags(args)
            return self.create_json_response(tags)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_products_reviews_list(self, args: dict):
        """List reviews"""
        try:
            reviews = self.db.list_reviews(args)
            return self.create_json_response(reviews)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - Orders ====================
    
    async def woo_orders_list(self, args: dict):
        """List orders"""
        try:
            orders = self.db.list_orders(args)
            return self.create_json_response(orders)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_get(self, args: dict):
        """Get an order"""
        try:
            order = self.db.get_order(args['orderId'])
            if not order:
                return self.create_error_response(f"Order {args['orderId']} not found")
            return self.create_json_response(order)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_create(self, args: dict):
        """Create an order"""
        try:
            order = self.db.create_order(args['orderData'])
            return self.create_json_response(order)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_update(self, args: dict):
        """Update an order"""
        try:
            order = self.db.update_order(args['orderId'], args['orderData'])
            return self.create_json_response(order)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_delete(self, args: dict):
        """Delete an order"""
        try:
            force = args.get('force', False)
            order = self.db.delete_order(args['orderId'], force)
            return self.create_json_response(order)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_batch_update(self, args: dict):
        """Batch update orders"""
        try:
            result = self.db.batch_update_orders(args)
            return self.create_json_response(result)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_notes_create(self, args: dict):
        """Create order note"""
        try:
            note_data = {
                'note': args['note'],
                'customer_note': args.get('customerNote', False)
            }
            note = self.db.create_order_note(args['orderId'], note_data)
            return self.create_json_response(note)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_orders_refunds_create(self, args: dict):
        """Create refund"""
        try:
            refund_data = {
                'amount': args.get('amount', '0'),
                'reason': args.get('reason', ''),
                'api_refund': args.get('refundPayment', False),
                'line_items': args.get('lineItems', [])
            }
            refund = self.db.create_refund(args['orderId'], refund_data)
            return self.create_json_response(refund)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - Customers ====================
    
    async def woo_customers_list(self, args: dict):
        """List customers"""
        try:
            customers = self.db.list_customers(args)
            return self.create_json_response(customers)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_customers_get(self, args: dict):
        """Get a customer"""
        try:
            customer = self.db.get_customer(args['customerId'])
            if not customer:
                return self.create_error_response(f"Customer {args['customerId']} not found")
            return self.create_json_response(customer)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_customers_create(self, args: dict):
        """Create a customer"""
        try:
            customer = self.db.create_customer(args['customerData'])
            return self.create_json_response(customer)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_customers_update(self, args: dict):
        """Update a customer"""
        try:
            customer = self.db.update_customer(args['customerId'], args['customerData'])
            return self.create_json_response(customer)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - Coupons ====================
    
    async def woo_coupons_list(self, args: dict):
        """List coupons"""
        try:
            coupons = self.db.list_coupons(args)
            return self.create_json_response(coupons)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_coupons_get(self, args: dict):
        """Get a coupon"""
        try:
            coupon = self.db.get_coupon(args['couponId'])
            if not coupon:
                return self.create_error_response(f"Coupon {args['couponId']} not found")
            return self.create_json_response(coupon)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_coupons_create(self, args: dict):
        """Create a coupon"""
        try:
            coupon = self.db.create_coupon(args['couponData'])
            return self.create_json_response(coupon)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_coupons_update(self, args: dict):
        """Update a coupon"""
        try:
            coupon = self.db.update_coupon(args['couponId'], args['couponData'])
            return self.create_json_response(coupon)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_coupons_delete(self, args: dict):
        """Delete a coupon"""
        try:
            force = args.get('force', True)
            coupon = self.db.delete_coupon(args['couponId'], force)
            return self.create_json_response(coupon)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - Reports ====================
    
    async def woo_reports_sales(self, args: dict):
        """Get sales report"""
        try:
            report = self.db.get_sales_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_reports_top_sellers(self, args: dict):
        """Get top sellers report"""
        try:
            report = self.db.get_top_sellers_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_reports_customers(self, args: dict):
        """Get customers report"""
        try:
            report = self.db.get_customers_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_reports_orders(self, args: dict):
        """Get orders report"""
        try:
            report = self.db.get_orders_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_reports_products(self, args: dict):
        """Get products report"""
        try:
            report = self.db.get_products_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_reports_stock(self, args: dict):
        """Get stock report"""
        try:
            report = self.db.get_stock_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_reports_low_stock(self, args: dict):
        """Get low stock report"""
        try:
            report = self.db.get_low_stock_report(args)
            return self.create_json_response(report)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - Shipping ====================
    
    async def woo_shipping_zones_list(self, args: dict):
        """List shipping zones"""
        try:
            zones = self.db.list_shipping_zones()
            return self.create_json_response(zones)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_shipping_zones_get(self, args: dict):
        """Get a shipping zone"""
        try:
            zone = self.db.get_shipping_zone(args['zoneId'])
            if not zone:
                return self.create_error_response(f"Shipping zone {args['zoneId']} not found")
            return self.create_json_response(zone)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_shipping_zones_create(self, args: dict):
        """Create a shipping zone"""
        try:
            zone = self.db.create_shipping_zone(args)
            return self.create_json_response(zone)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_shipping_zones_update(self, args: dict):
        """Update a shipping zone"""
        try:
            zone_id = args.pop('zoneId')
            zone = self.db.update_shipping_zone(zone_id, args)
            return self.create_json_response(zone)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_shipping_zone_methods_list(self, args: dict):
        """List shipping zone methods"""
        try:
            methods = self.db.list_shipping_zone_methods(args['zoneId'])
            return self.create_json_response(methods)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_shipping_zone_methods_create(self, args: dict):
        """Create shipping zone method"""
        try:
            zone_id = args.pop('zoneId')
            method = self.db.create_shipping_zone_method(zone_id, args)
            return self.create_json_response(method)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - Tax ====================
    
    async def woo_tax_rates_list(self, args: dict):
        """List tax rates"""
        try:
            rates = self.db.list_tax_rates(args)
            return self.create_json_response(rates)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_tax_rates_get(self, args: dict):
        """Get a tax rate"""
        try:
            rate = self.db.get_tax_rate(args['rateId'])
            if not rate:
                return self.create_error_response(f"Tax rate {args['rateId']} not found")
            return self.create_json_response(rate)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_tax_rates_create(self, args: dict):
        """Create a tax rate"""
        try:
            rate = self.db.create_tax_rate(args)
            return self.create_json_response(rate)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_tax_classes_list(self, args: dict):
        """List tax classes"""
        try:
            classes = self.db.list_tax_classes()
            return self.create_json_response(classes)
        except Exception as e:
            return self.create_error_response(str(e))
    
    # ==================== Tool Handlers - System ====================
    
    async def woo_system_status(self, args: dict):
        """Get system status"""
        try:
            status = self.db.get_system_status()
            return self.create_json_response(status)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_system_tools_list(self, args: dict):
        """List system tools"""
        try:
            tools = self.db.list_system_tools()
            return self.create_json_response(tools)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_system_tools_run(self, args: dict):
        """Run a system tool"""
        try:
            result = self.db.run_system_tool(args['toolId'])
            return self.create_json_response(result)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_settings_list(self, args: dict):
        """List settings groups"""
        try:
            groups = self.db.list_settings_groups()
            return self.create_json_response(groups)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_settings_get(self, args: dict):
        """Get settings group"""
        try:
            settings = self.db.get_settings_group(args['groupId'])
            return self.create_json_response(settings)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_payment_gateways_list(self, args: dict):
        """List payment gateways"""
        try:
            gateways = self.db.list_payment_gateways()
            return self.create_json_response(gateways)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_payment_gateways_get(self, args: dict):
        """Get a payment gateway"""
        try:
            gateway = self.db.get_payment_gateway(args['gatewayId'])
            if not gateway:
                return self.create_error_response(f"Payment gateway {args['gatewayId']} not found")
            return self.create_json_response(gateway)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_payment_gateways_update(self, args: dict):
        """Update a payment gateway"""
        try:
            gateway_id = args.pop('gatewayId')
            gateway = self.db.update_payment_gateway(gateway_id, args)
            return self.create_json_response(gateway)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_webhooks_list(self, args: dict):
        """List webhooks"""
        try:
            webhooks = self.db.list_webhooks(args)
            return self.create_json_response(webhooks)
        except Exception as e:
            return self.create_error_response(str(e))
    
    async def woo_webhooks_create(self, args: dict):
        """Create a webhook"""
        try:
            webhook = self.db.create_webhook(args)
            return self.create_json_response(webhook)
        except Exception as e:
            return self.create_error_response(str(e))


async def main():
    """Main entry point"""
    server = WooCommerceMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
