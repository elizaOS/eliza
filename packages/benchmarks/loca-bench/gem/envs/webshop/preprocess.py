import argparse
import json
import math
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, Sequence

from datasets import load_dataset
from tqdm import tqdm

BASE_DIR = Path(".cache/webshop")
RESOURCE_DIR = BASE_DIR / "resources"
DOCS_PATH = RESOURCE_DIR / "documents.jsonl"
DB_PATH = BASE_DIR / "webshop.db"


def _json_safe(value: Any) -> Any:
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def _serialize(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


def _to_text(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_product(raw: Dict[str, Any]) -> Dict[str, Any]:
    product: Dict[str, Any] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            try:
                product[key] = json.loads(value)
                continue
            except Exception:
                pass
        product[key] = value
    return _json_safe(product)


def _init_db_products(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        DROP TABLE IF EXISTS all_products;

        CREATE TABLE all_products (
            asin TEXT PRIMARY KEY,
            name TEXT,
            full_description TEXT,
            pricing REAL,
            images TEXT,
            product_category TEXT,
            average_rating REAL,
            small_description TEXT,
            title TEXT,
            description TEXT,
            reviews TEXT,
            rating REAL,
            bullet_points TEXT,
            price TEXT,
            options TEXT,
            option_to_image TEXT,
            attributes TEXT,
            instruction_text TEXT,
            instruction_attributes TEXT,
            main_image TEXT,
            category TEXT,
            query TEXT,
            page INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_all_products_query
            ON all_products(query);

        CREATE INDEX IF NOT EXISTS idx_all_products_category
            ON all_products(category);
        """
    )


def _init_db_goals(conn: sqlite3.Connection, split: str) -> None:
    conn.executescript(
        f"""
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        DROP TABLE IF EXISTS goals_{split};

        CREATE TABLE goals_{split} (
            idx INTEGER PRIMARY KEY,
            asin TEXT,
            category TEXT,
            query TEXT,
            name TEXT,
            product_category TEXT,
            instruction_text TEXT,
            attributes TEXT,
            price_upper REAL,
            goal_options TEXT,
            weight REAL
        );
        """
    )


def build_documents_jsonl(raw_products: Sequence[Dict[str, Any]]) -> None:
    docs = []
    for p in tqdm(raw_products, total=len(raw_products), desc="Building documents"):
        option_texts = []
        options = p.get("options", "{}")
        if isinstance(options, str):
            try:
                options = json.loads(options)
            except Exception:
                options = {}
        for option_name, option_contents in (options or {}).items():
            option_contents_text = ", ".join(option_contents)
            option_texts.append(f"{option_name}: {option_contents_text}")
        option_text = ", and ".join(option_texts)

        doc = {
            "id": p.get("asin"),
            "contents": " ".join(
                [
                    p["Title"],
                    p["Description"],
                    p["BulletPoints"][0],
                    option_text,
                ]
            ).lower(),
            "product": p,
        }
        docs.append(doc)

    RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
    with DOCS_PATH.open("w") as f:
        for doc in docs:
            f.write(json.dumps(doc) + "\n")
    print(f"Saved {len(docs)} documents to {DOCS_PATH}.")


def _populate_products(
    conn: sqlite3.Connection,
    products: Iterable[Dict[str, Any]],
) -> None:
    insert_products = []

    for product in products:
        asin = product.get("asin")
        if not asin:
            continue

        name = product.get("name")
        full_description = product.get("full_description")
        pricing = _serialize(product.get("pricing"))
        images = _serialize(product.get("images"))
        product_category = product.get("product_category")
        average_rating = _to_text(product.get("average_rating"))
        small_description = _serialize(product.get("small_description"))
        title = product.get("Title")
        description = product.get("Description")
        reviews = _serialize(product.get("Reviews"))
        rating = _to_text(product.get("Rating"))
        bullet_points = _serialize(product.get("BulletPoints"))
        price = product.get("Price")
        options = _serialize(product.get("options"))
        option_to_image = _serialize(product.get("option_to_image"))
        attributes = _serialize(product.get("Attributes"))
        instruction_text = product.get("instruction_text")
        instruction_attributes = _serialize(product.get("instruction_attributes"))
        main_image = product.get("MainImage")
        category = product.get("category")
        query = product.get("query")
        page = _to_int(product.get("page"))

        insert_products.append(
            (
                asin,
                name,
                full_description,
                pricing,
                images,
                product_category,
                average_rating,
                small_description,
                title,
                description,
                reviews,
                rating,
                bullet_points,
                price,
                options,
                option_to_image,
                attributes,
                instruction_text,
                instruction_attributes,
                main_image,
                category,
                query,
                page,
            )
        )

    with conn:
        conn.executemany(
            """
            INSERT INTO all_products (
                asin,
                name,
                full_description,
                pricing,
                images,
                product_category,
                average_rating,
                small_description,
                title,
                description,
                reviews,
                rating,
                bullet_points,
                price,
                options,
                option_to_image,
                attributes,
                instruction_text,
                instruction_attributes,
                main_image,
                category,
                query,
                page
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            insert_products,
        )


def _populate_goals(conn: sqlite3.Connection, split: str) -> None:
    goals = load_dataset("axon-rl/webshop_instructions", split=split).to_list()
    goals = [_parse_product(item) for item in tqdm(goals, desc="Parsing goals")]
    insert_goals = []

    for i, goal in enumerate(goals):
        idx = i
        asin = goal.get("asin")
        category = goal.get("category")
        query = goal.get("query")
        name = goal.get("name")
        product_category = goal.get("product_category")
        instruction_text = goal.get("instruction_text")
        attributes = _serialize(goal.get("attributes"))
        price_upper = _to_text(goal.get("price_upper"))
        goal_options = _serialize(goal.get("goal_options"))
        weight = _to_text(goal.get("weight"))

        insert_goals.append(
            (
                idx,
                asin,
                category,
                query,
                name,
                product_category,
                instruction_text,
                attributes,
                price_upper,
                goal_options,
                weight,
            )
        )

    with conn:
        conn.executemany(
            f"""
            INSERT INTO goals_{split} (
                idx,
                asin,
                category,
                query,
                name,
                product_category,
                instruction_text,
                attributes,
                price_upper,
                goal_options,
                weight
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            insert_goals,
        )


def run(mode: str) -> None:
    print("Loading raw dataset...")
    raw_products = load_dataset("axon-rl/webshop", split="train").to_list()
    print(f"Loaded {len(raw_products)} raw products.")

    if mode in {"documents", "all"}:
        print("Building legacy documents cache...")
        build_documents_jsonl(raw_products)

    if mode not in {"database", "all"}:
        return

    products = [
        _parse_product(item) for item in tqdm(raw_products, desc="Parsing products")
    ]

    print("Preparing SQLite database...")
    RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
    # if there is an existing DB, remove it
    if DB_PATH.exists():
        DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    try:
        _init_db_products(conn)
        _populate_products(conn, products)
        print(f"Populated products into {DB_PATH}.")
        del products
        _init_db_goals(conn, split="test")
        _populate_goals(conn, split="test")
        print(f"Populated goals test into {DB_PATH}.")
        _init_db_goals(conn, split="train")
        _populate_goals(conn, split="train")
        print(f"Populated goals train into {DB_PATH}.")
    finally:
        conn.close()

    print(f"Database saved to {DB_PATH}.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build WebShop cached resources.")
    parser.add_argument(
        "--mode",
        choices=("all", "documents", "database"),
        default="all",
        help="Select which preprocessing artifacts to generate.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run(args.mode)
