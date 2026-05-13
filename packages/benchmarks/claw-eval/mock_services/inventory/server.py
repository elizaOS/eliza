"""Mock Inventory API service for agent evaluation (FastAPI on port 9108)."""

from __future__ import annotations

import json
import copy
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Mock Inventory API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "INVENTORY_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T019zh_inventory_check" / "fixtures" / "inventory" / "products.json"),
))

_products: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_orders: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _products
    with open(FIXTURES_PATH) as f:
        _products = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class ListProductsRequest(BaseModel):
    category: str | None = None


class GetProductRequest(BaseModel):
    product_id: str


class CreateOrderRequest(BaseModel):
    product_id: str
    quantity: int
    supplier: str | None = None


@app.post("/inventory/products")
def list_products(req: ListProductsRequest | None = None) -> dict[str, Any]:
    if req is None:
        req = ListProductsRequest()
    results = []
    for p in _products:
        if req.category and p["category"] != req.category:
            continue
        results.append(copy.deepcopy(p))
    resp = {"products": results, "total": len(results)}
    _log_call("/inventory/products", req.model_dump(), resp)
    return resp


@app.post("/inventory/products/get")
def get_product(req: GetProductRequest) -> dict[str, Any]:
    for p in _products:
        if p["product_id"] == req.product_id:
            resp = copy.deepcopy(p)
            _log_call("/inventory/products/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Product {req.product_id} not found"}
    _log_call("/inventory/products/get", req.model_dump(), resp)
    return resp


@app.post("/inventory/orders/create")
def create_order(req: CreateOrderRequest) -> dict[str, Any]:
    order = {
        "product_id": req.product_id,
        "quantity": req.quantity,
        "supplier": req.supplier,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _orders.append(order)
    resp = {"status": "created", "order": order}
    _log_call("/inventory/orders/create", req.model_dump(), resp)
    return resp


@app.get("/inventory/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "orders": _orders}


@app.post("/inventory/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _orders
    _audit_log = []
    _orders = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9108")))
