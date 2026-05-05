"""
Retail domain environment for Tau-bench.

Simulates an e-commerce customer service environment with:
- Order management (view, modify, cancel)
- Return processing
- Refund handling
- Customer information management
- Product inquiries
"""

from datetime import datetime, timedelta
from typing import Any

from elizaos_tau_bench.types import (
    TauBenchTask,
    ToolCall,
    ToolCallStatus,
    ToolDefinition,
    PolicyConstraint,
    TauDomain,
)
from elizaos_tau_bench.environments.base import DomainEnvironment


class RetailEnvironment(DomainEnvironment):
    """Simulated retail/e-commerce environment."""

    def __init__(self, task: TauBenchTask) -> None:
        super().__init__(task)
        self.domain = TauDomain.RETAIL

    async def initialize(self) -> None:
        """Initialize retail environment with mock data."""
        init_data = self.task.initialization_data

        # Default mock database structure
        self.state = {
            "orders": init_data.get("orders", {
                "ORD-12345": {
                    "order_id": "ORD-12345",
                    "customer_id": "CUST-001",
                    "status": "delivered",
                    "items": [
                        {"product_id": "PROD-001", "name": "Wireless Headphones", "price": 149.99, "quantity": 1},
                        {"product_id": "PROD-002", "name": "Phone Case", "price": 29.99, "quantity": 2},
                    ],
                    "subtotal": 209.97,
                    "shipping": 9.99,
                    "tax": 18.90,
                    "total": 238.86,
                    "shipping_address": {
                        "street": "123 Main St",
                        "city": "San Francisco",
                        "state": "CA",
                        "zip": "94102",
                    },
                    "order_date": (datetime.now() - timedelta(days=5)).isoformat(),
                    "delivery_date": (datetime.now() - timedelta(days=1)).isoformat(),
                    "payment_method": "credit_card_ending_4242",
                },
                "ORD-12346": {
                    "order_id": "ORD-12346",
                    "customer_id": "CUST-001",
                    "status": "processing",
                    "items": [
                        {"product_id": "PROD-003", "name": "Laptop Stand", "price": 79.99, "quantity": 1},
                    ],
                    "subtotal": 79.99,
                    "shipping": 0.00,
                    "tax": 7.20,
                    "total": 87.19,
                    "shipping_address": {
                        "street": "123 Main St",
                        "city": "San Francisco",
                        "state": "CA",
                        "zip": "94102",
                    },
                    "order_date": datetime.now().isoformat(),
                    "estimated_delivery": (datetime.now() + timedelta(days=5)).isoformat(),
                    "payment_method": "credit_card_ending_4242",
                },
            }),
            "customers": init_data.get("customers", {
                "CUST-001": {
                    "customer_id": "CUST-001",
                    "name": "John Smith",
                    "email": "john.smith@example.com",
                    "phone": "+1-555-0123",
                    "membership_tier": "gold",
                    "account_created": "2022-03-15",
                    "total_orders": 12,
                    "total_spent": 2450.00,
                },
            }),
            "products": init_data.get("products", {
                "PROD-001": {
                    "product_id": "PROD-001",
                    "name": "Wireless Headphones",
                    "price": 149.99,
                    "category": "Electronics",
                    "in_stock": True,
                    "stock_quantity": 50,
                },
                "PROD-002": {
                    "product_id": "PROD-002",
                    "name": "Phone Case",
                    "price": 29.99,
                    "category": "Accessories",
                    "in_stock": True,
                    "stock_quantity": 200,
                },
                "PROD-003": {
                    "product_id": "PROD-003",
                    "name": "Laptop Stand",
                    "price": 79.99,
                    "category": "Accessories",
                    "in_stock": True,
                    "stock_quantity": 25,
                },
            }),
            "returns": init_data.get("returns", {}),
            "refunds": init_data.get("refunds", {}),
            "policies": {
                "return_window_days": 30,
                "requires_receipt": False,
                "restocking_fee_percent": 0,
                "refund_processing_days": 5,
                "free_shipping_threshold": 50.00,
            },
        }

        self.initialized = True

    async def execute_tool(self, tool_call: ToolCall) -> Any:
        """Execute a retail domain tool call."""
        self.tool_call_history.append(tool_call)

        tool_handlers = {
            "get_order_details": self._get_order_details,
            "get_order_status": self._get_order_status,
            "list_customer_orders": self._list_customer_orders,
            "cancel_order": self._cancel_order,
            "modify_order": self._modify_order,
            "initiate_return": self._initiate_return,
            "get_return_status": self._get_return_status,
            "process_refund": self._process_refund,
            "get_customer_info": self._get_customer_info,
            "update_shipping_address": self._update_shipping_address,
            "get_product_info": self._get_product_info,
            "check_product_availability": self._check_product_availability,
            "apply_discount_code": self._apply_discount_code,
            "get_return_policy": self._get_return_policy,
            "escalate_to_supervisor": self._escalate_to_supervisor,
        }

        handler = tool_handlers.get(tool_call.tool_name)
        if handler:
            try:
                result = await handler(tool_call.arguments)
                tool_call.result = result
                tool_call.status = ToolCallStatus.CORRECT
                return result
            except Exception as e:
                tool_call.status = ToolCallStatus.EXECUTION_ERROR
                tool_call.error_message = str(e)
                return {"error": str(e)}
        else:
            tool_call.status = ToolCallStatus.WRONG_TOOL
            tool_call.error_message = f"Unknown tool: {tool_call.tool_name}"
            return {"error": f"Unknown tool: {tool_call.tool_name}"}

    async def _get_order_details(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get detailed information about an order."""
        order_id = args.get("order_id")
        if not order_id:
            return {"error": "order_id is required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        return order

    async def _get_order_status(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get the status of an order."""
        order_id = args.get("order_id")
        if not order_id:
            return {"error": "order_id is required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        return {
            "order_id": order_id,
            "status": order["status"],
            "last_updated": order.get("delivery_date") or order.get("order_date"),
        }

    async def _list_customer_orders(self, args: dict[str, Any]) -> dict[str, Any]:
        """List all orders for a customer."""
        customer_id = args.get("customer_id")
        if not customer_id:
            return {"error": "customer_id is required"}

        orders = [
            {"order_id": o["order_id"], "status": o["status"], "total": o["total"]}
            for o in self.state["orders"].values()
            if o["customer_id"] == customer_id
        ]

        return {"customer_id": customer_id, "orders": orders, "count": len(orders)}

    async def _cancel_order(self, args: dict[str, Any]) -> dict[str, Any]:
        """Cancel an order."""
        order_id = args.get("order_id")
        reason = args.get("reason", "Customer requested")

        if not order_id:
            return {"error": "order_id is required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        if order["status"] in ["delivered", "cancelled"]:
            return {"error": f"Cannot cancel order with status: {order['status']}"}

        # Update order status
        self.state["orders"][order_id]["status"] = "cancelled"
        self.state["orders"][order_id]["cancellation_reason"] = reason
        self.state["orders"][order_id]["cancelled_at"] = datetime.now().isoformat()

        return {
            "success": True,
            "order_id": order_id,
            "new_status": "cancelled",
            "refund_initiated": True,
            "message": f"Order {order_id} has been cancelled. Refund will be processed within 5 business days.",
        }

    async def _modify_order(self, args: dict[str, Any]) -> dict[str, Any]:
        """Modify an existing order."""
        order_id = args.get("order_id")
        modifications = args.get("modifications", {})

        if not order_id:
            return {"error": "order_id is required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        if order["status"] not in ["pending", "processing"]:
            return {"error": f"Cannot modify order with status: {order['status']}"}

        # Apply modifications
        if "shipping_address" in modifications:
            self.state["orders"][order_id]["shipping_address"] = modifications["shipping_address"]

        return {
            "success": True,
            "order_id": order_id,
            "modifications_applied": list(modifications.keys()),
        }

    async def _initiate_return(self, args: dict[str, Any]) -> dict[str, Any]:
        """Initiate a return for an order."""
        order_id = args.get("order_id")
        items = args.get("items", [])  # List of product_ids to return
        reason = args.get("reason", "")

        if not order_id:
            return {"error": "order_id is required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        if order["status"] != "delivered":
            return {"error": "Only delivered orders can be returned"}

        # Check return window
        delivery_date = datetime.fromisoformat(order["delivery_date"])
        if (datetime.now() - delivery_date).days > self.state["policies"]["return_window_days"]:
            return {"error": "Return window has expired"}

        # Create return
        return_id = f"RET-{order_id}"
        self.state["returns"][return_id] = {
            "return_id": return_id,
            "order_id": order_id,
            "items": items if items else [item["product_id"] for item in order["items"]],
            "reason": reason,
            "status": "initiated",
            "created_at": datetime.now().isoformat(),
            "return_label_url": f"https://returns.example.com/label/{return_id}",
        }

        return {
            "success": True,
            "return_id": return_id,
            "status": "initiated",
            "return_label_url": f"https://returns.example.com/label/{return_id}",
            "instructions": "Print the return label and ship the items within 14 days.",
        }

    async def _get_return_status(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get status of a return."""
        return_id = args.get("return_id")
        if not return_id:
            return {"error": "return_id is required"}

        ret = self.state["returns"].get(return_id)
        if not ret:
            return {"error": f"Return {return_id} not found"}

        return ret

    async def _process_refund(self, args: dict[str, Any]) -> dict[str, Any]:
        """Process a refund."""
        order_id = args.get("order_id")
        amount = args.get("amount")
        reason = args.get("reason", "")

        if not order_id:
            return {"error": "order_id is required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        refund_amount = amount if amount else order["total"]
        refund_id = f"REF-{order_id}"

        self.state["refunds"][refund_id] = {
            "refund_id": refund_id,
            "order_id": order_id,
            "amount": refund_amount,
            "reason": reason,
            "status": "processing",
            "created_at": datetime.now().isoformat(),
            "estimated_completion": (datetime.now() + timedelta(days=5)).isoformat(),
        }

        return {
            "success": True,
            "refund_id": refund_id,
            "amount": refund_amount,
            "status": "processing",
            "estimated_days": 5,
        }

    async def _get_customer_info(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get customer information."""
        customer_id = args.get("customer_id")
        if not customer_id:
            return {"error": "customer_id is required"}

        customer = self.state["customers"].get(customer_id)
        if not customer:
            return {"error": f"Customer {customer_id} not found"}

        return customer

    async def _update_shipping_address(self, args: dict[str, Any]) -> dict[str, Any]:
        """Update shipping address for an order."""
        order_id = args.get("order_id")
        address = args.get("address")

        if not order_id or not address:
            return {"error": "order_id and address are required"}

        order = self.state["orders"].get(order_id)
        if not order:
            return {"error": f"Order {order_id} not found"}

        if order["status"] not in ["pending", "processing"]:
            return {"error": f"Cannot update address for order with status: {order['status']}"}

        self.state["orders"][order_id]["shipping_address"] = address

        return {"success": True, "order_id": order_id, "new_address": address}

    async def _get_product_info(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get product information."""
        product_id = args.get("product_id")
        if not product_id:
            return {"error": "product_id is required"}

        product = self.state["products"].get(product_id)
        if not product:
            return {"error": f"Product {product_id} not found"}

        return product

    async def _check_product_availability(self, args: dict[str, Any]) -> dict[str, Any]:
        """Check if a product is available."""
        product_id = args.get("product_id")
        quantity = args.get("quantity", 1)

        if not product_id:
            return {"error": "product_id is required"}

        product = self.state["products"].get(product_id)
        if not product:
            return {"error": f"Product {product_id} not found"}

        available = product["in_stock"] and product["stock_quantity"] >= quantity

        return {
            "product_id": product_id,
            "available": available,
            "stock_quantity": product["stock_quantity"],
            "requested_quantity": quantity,
        }

    async def _apply_discount_code(self, args: dict[str, Any]) -> dict[str, Any]:
        """Apply a discount code to an order."""
        order_id = args.get("order_id")
        code = args.get("code")

        if not order_id or not code:
            return {"error": "order_id and code are required"}

        # Mock discount codes
        valid_codes = {
            "SAVE10": {"type": "percent", "value": 10},
            "SAVE20": {"type": "percent", "value": 20},
            "FLAT25": {"type": "flat", "value": 25.00},
        }

        if code.upper() not in valid_codes:
            return {"error": "Invalid discount code"}

        return {
            "success": True,
            "code": code,
            "discount": valid_codes[code.upper()],
            "message": f"Discount code {code} applied successfully",
        }

    async def _get_return_policy(self, args: dict[str, Any]) -> dict[str, Any]:
        """Get return policy information."""
        return {
            "return_window_days": self.state["policies"]["return_window_days"],
            "requires_receipt": self.state["policies"]["requires_receipt"],
            "restocking_fee_percent": self.state["policies"]["restocking_fee_percent"],
            "refund_processing_days": self.state["policies"]["refund_processing_days"],
            "conditions": [
                "Items must be unused and in original packaging",
                "Electronics must include all accessories",
                "Final sale items cannot be returned",
            ],
        }

    async def _escalate_to_supervisor(self, args: dict[str, Any]) -> dict[str, Any]:
        """Escalate an issue to a supervisor."""
        reason = args.get("reason", "")

        return {
            "success": True,
            "ticket_id": f"ESC-{datetime.now().strftime('%Y%m%d%H%M%S')}",
            "message": "Issue has been escalated to a supervisor. Expected response within 24 hours.",
            "reason": reason,
        }

    async def check_policy_compliance(self) -> list[str]:
        """Check for policy violations in the tool call history."""
        violations = []

        for call in self.tool_call_history:
            # Check return window policy
            if call.tool_name == "initiate_return":
                order_id = call.arguments.get("order_id")
                order = self.state["orders"].get(order_id)
                if order and order.get("delivery_date"):
                    delivery_date = datetime.fromisoformat(order["delivery_date"])
                    if (datetime.now() - delivery_date).days > self.state["policies"]["return_window_days"]:
                        violations.append(f"Return initiated outside {self.state['policies']['return_window_days']}-day window")

            # Check refund authorization
            if call.tool_name == "process_refund":
                amount = call.arguments.get("amount", 0)
                if amount > 500:
                    # High-value refunds need supervisor approval
                    has_escalation = any(
                        c.tool_name == "escalate_to_supervisor"
                        for c in self.tool_call_history
                    )
                    if not has_escalation:
                        violations.append("High-value refund (>$500) processed without supervisor approval")

        return violations

    async def check_goal_achieved(self) -> bool:
        """Check if the task goal has been achieved."""
        success_criteria = self.task.success_criteria

        for criterion in success_criteria:
            if criterion == "order_cancelled":
                # Check if any order was cancelled
                cancelled = any(
                    o["status"] == "cancelled"
                    for o in self.state["orders"].values()
                )
                if not cancelled:
                    return False

            elif criterion == "return_initiated":
                if not self.state["returns"]:
                    return False

            elif criterion == "refund_processed":
                if not self.state["refunds"]:
                    return False

            elif criterion.startswith("order_status:"):
                expected_status = criterion.split(":")[1]
                # Check if any order has the expected status
                has_status = any(
                    o["status"] == expected_status
                    for o in self.state["orders"].values()
                )
                if not has_status:
                    return False

        return True

    @classmethod
    def default_tools(cls) -> list[ToolDefinition]:
        """Get the default tool set for the retail domain."""
        return [
            ToolDefinition(
                name="get_order_details",
                description="Retrieve complete details of a customer order including items, prices, shipping info",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The unique order identifier"}
                    },
                    "required": ["order_id"],
                },
                returns={"type": "object", "description": "Order details object"},
            ),
            ToolDefinition(
                name="get_order_status",
                description="Get the current status of an order",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The unique order identifier"}
                    },
                    "required": ["order_id"],
                },
            ),
            ToolDefinition(
                name="list_customer_orders",
                description="List all orders for a specific customer",
                parameters={
                    "type": "object",
                    "properties": {
                        "customer_id": {"type": "string", "description": "The customer identifier"}
                    },
                    "required": ["customer_id"],
                },
            ),
            ToolDefinition(
                name="cancel_order",
                description="Cancel an order that hasn't been delivered yet",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The order to cancel"},
                        "reason": {"type": "string", "description": "Reason for cancellation"},
                    },
                    "required": ["order_id"],
                },
            ),
            ToolDefinition(
                name="modify_order",
                description="Modify an order (shipping address, items, etc.)",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The order to modify"},
                        "modifications": {"type": "object", "description": "Modifications to apply"},
                    },
                    "required": ["order_id", "modifications"],
                },
            ),
            ToolDefinition(
                name="initiate_return",
                description="Start the return process for a delivered order",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The order to return"},
                        "items": {"type": "array", "description": "Product IDs to return (empty for all)"},
                        "reason": {"type": "string", "description": "Reason for return"},
                    },
                    "required": ["order_id"],
                },
            ),
            ToolDefinition(
                name="get_return_status",
                description="Check the status of a return request",
                parameters={
                    "type": "object",
                    "properties": {
                        "return_id": {"type": "string", "description": "The return identifier"}
                    },
                    "required": ["return_id"],
                },
            ),
            ToolDefinition(
                name="process_refund",
                description="Process a refund for an order",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The order to refund"},
                        "amount": {"type": "number", "description": "Refund amount (optional, defaults to order total)"},
                        "reason": {"type": "string", "description": "Reason for refund"},
                    },
                    "required": ["order_id"],
                },
            ),
            ToolDefinition(
                name="get_customer_info",
                description="Get customer account information",
                parameters={
                    "type": "object",
                    "properties": {
                        "customer_id": {"type": "string", "description": "The customer identifier"}
                    },
                    "required": ["customer_id"],
                },
            ),
            ToolDefinition(
                name="update_shipping_address",
                description="Update the shipping address for an order",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The order to update"},
                        "address": {"type": "object", "description": "New shipping address"},
                    },
                    "required": ["order_id", "address"],
                },
            ),
            ToolDefinition(
                name="get_product_info",
                description="Get information about a product",
                parameters={
                    "type": "object",
                    "properties": {
                        "product_id": {"type": "string", "description": "The product identifier"}
                    },
                    "required": ["product_id"],
                },
            ),
            ToolDefinition(
                name="check_product_availability",
                description="Check if a product is available in stock",
                parameters={
                    "type": "object",
                    "properties": {
                        "product_id": {"type": "string", "description": "The product to check"},
                        "quantity": {"type": "integer", "description": "Quantity needed (default: 1)"},
                    },
                    "required": ["product_id"],
                },
            ),
            ToolDefinition(
                name="apply_discount_code",
                description="Apply a discount code to an order",
                parameters={
                    "type": "object",
                    "properties": {
                        "order_id": {"type": "string", "description": "The order to apply discount"},
                        "code": {"type": "string", "description": "The discount code"},
                    },
                    "required": ["order_id", "code"],
                },
            ),
            ToolDefinition(
                name="get_return_policy",
                description="Get information about the return policy",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="escalate_to_supervisor",
                description="Escalate a customer issue to a supervisor",
                parameters={
                    "type": "object",
                    "properties": {
                        "reason": {"type": "string", "description": "Reason for escalation"},
                        "customer_id": {"type": "string", "description": "Customer ID"},
                        "order_id": {"type": "string", "description": "Related order ID"},
                    },
                    "required": ["reason"],
                },
            ),
        ]

    def get_available_tools(self) -> list[ToolDefinition]:
        """Get list of available tools for retail domain."""
        return self.default_tools()

    def get_policy_constraints(self) -> list[PolicyConstraint]:
        """Get policy constraints for retail domain."""
        return [
            PolicyConstraint(
                policy_id="RETURN_WINDOW",
                description="Returns must be initiated within 30 days of delivery",
                check_function="check_return_window",
                severity="error",
                domain=TauDomain.RETAIL,
            ),
            PolicyConstraint(
                policy_id="REFUND_AUTH",
                description="Refunds over $500 require supervisor approval",
                check_function="check_refund_authorization",
                severity="error",
                domain=TauDomain.RETAIL,
            ),
            PolicyConstraint(
                policy_id="ORDER_MODIFY",
                description="Only pending/processing orders can be modified",
                check_function="check_order_modifiable",
                severity="error",
                domain=TauDomain.RETAIL,
            ),
            PolicyConstraint(
                policy_id="CUSTOMER_VERIFY",
                description="Verify customer identity before sharing order details",
                check_function="check_customer_verified",
                severity="warning",
                domain=TauDomain.RETAIL,
            ),
        ]
