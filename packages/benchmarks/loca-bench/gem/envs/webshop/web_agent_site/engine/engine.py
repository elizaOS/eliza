""" """

import json
import os
import random
import re
import sqlite3
from ast import literal_eval
from collections import defaultdict
from decimal import Decimal
from typing import Optional, Tuple

from flask import render_template_string
from pyserini.search.lucene import LuceneSearcher
from rich import print
from tqdm import tqdm

from gem.envs.webshop.web_agent_site.utils import (
    BASE_DIR,
    DEFAULT_ATTR_PATH,
    HUMAN_ATTR_PATH,
)

WEBSHOP_DB_PATH = ".cache/webshop/webshop.db"
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")

SEARCH_RETURN_N = 50
PRODUCT_WINDOW = 10
TOP_K_ATTR = 10

END_BUTTON = "buy now"
NEXT_PAGE = "next >"
PREV_PAGE = "< prev"
BACK_TO_SEARCH = "back to search"

ACTION_TO_TEMPLATE = {
    "description": "description_page.html",
    "features": "features_page.html",
    "reviews": "review_page.html",
    "attributes": "attributes_page.html",
}


def parse_action(action: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Parse action string to action name and its arguments.
    """
    action_search_pattern = re.compile(r"(.+)\[(.+)\]")  # e.g. click[value]
    match = re.match(action_search_pattern, action)
    if match:
        action_name, action_arg = match.groups()
        if action_arg == "":
            action_arg = None
    else:
        action_name, action_arg = action, None  # e.g. "start"
    if action_arg is not None:
        action_arg = action_arg.lower()
    return action_name, action_arg


def map_action_to_html(action, **kwargs):
    action_name, action_arg = parse_action(action)
    if action_name == "start":
        path = os.path.join(TEMPLATE_DIR, "search_page.html")
        html = render_template_string(
            read_html_template(path=path),
            session_id=kwargs["session_id"],
            instruction_text=kwargs["instruction_text"],
        )
    elif action_name == "search":
        path = os.path.join(TEMPLATE_DIR, "results_page.html")
        html = render_template_string(
            read_html_template(path=path),
            session_id=kwargs["session_id"],
            products=kwargs["products"],
            keywords=kwargs["keywords"],
            page=kwargs["page"],
            total=kwargs["total"],
            instruction_text=kwargs["instruction_text"],
        )
    elif action_name == "click" and action_arg == END_BUTTON:
        path = os.path.join(TEMPLATE_DIR, "done_page.html")
        html = render_template_string(
            read_html_template(path),
            session_id=kwargs["session_id"],
            reward=kwargs["reward"],
            asin=kwargs["asin"],
            options=kwargs["options"],
            reward_info=kwargs.get("reward_info"),
            goal_attrs=kwargs.get("goal_attrs"),
            purchased_attrs=kwargs.get("purchased_attrs"),
            goal=kwargs.get("goal"),
            mturk_code=kwargs.get("mturk_code"),
            query=kwargs.get("query"),
            category=kwargs.get("category"),
            product_category=kwargs.get("product_category"),
        )
    elif action_name == "click" and action_arg in ACTION_TO_TEMPLATE:
        path = os.path.join(TEMPLATE_DIR, ACTION_TO_TEMPLATE[action_arg])
        html = render_template_string(
            read_html_template(path),
            session_id=kwargs["session_id"],
            product_info=kwargs["product_info"],
            keywords=kwargs["keywords"],
            page=kwargs["page"],
            asin=kwargs["asin"],
            options=kwargs["options"],
            instruction_text=kwargs.get("instruction_text"),
        )
    elif action_name == "click":  # should be item click
        path = os.path.join(TEMPLATE_DIR, "item_page.html")
        html = render_template_string(
            read_html_template(path),
            session_id=kwargs["session_id"],
            product_info=kwargs["product_info"],
            keywords=kwargs["keywords"],
            page=kwargs["page"],
            asin=kwargs["asin"],
            options=kwargs["options"],
            instruction_text=kwargs.get("instruction_text"),
            show_attrs=kwargs["show_attrs"],
        )
    else:
        raise ValueError("Action name not recognized.")
    return html


def read_html_template(path):
    with open(path) as f:
        template = f.read()
    return template


def convert_web_app_string_to_var(name, string):
    if name == "keywords":
        keywords = string
        if keywords.startswith("["):
            keywords = literal_eval(keywords)
        else:
            keywords = [keywords]
        var = keywords
    elif name == "page":
        page = string
        page = int(page)
        var = page
    else:
        raise ValueError("Name of variable not recognized.")
    return var


def maybe_json(value):
    # handle empty string and None
    if value == "":
        return value
    if value is None:
        return ""

    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ""
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return value
    return value


def get_goal_by_idx(idx, split):
    db_path = WEBSHOP_DB_PATH
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"webshop.db not found at {db_path}")

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            f"SELECT * FROM goals_{split} WHERE idx = ? LIMIT 1",
            (idx,),
        ).fetchone()

    if row is None:
        return None

    goal = dict(row)
    for key in goal.keys():
        goal[key] = maybe_json(goal[key])
    return goal


def get_weights(split):
    db_path = WEBSHOP_DB_PATH
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"webshop.db not found at {db_path}")

    weights = []
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(f"SELECT weight FROM goals_{split}")
        rows = cursor.fetchall()
        for row in rows:
            weights.append(row[0])

    return weights


def get_product_by_asin(asin):
    db_path = WEBSHOP_DB_PATH
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"webshop.db not found at {db_path}")

    key_map = {
        "asin": "asin",
        "name": "name",
        "full_description": "full_description",
        "pricing": "pricing",
        "images": "images",
        "product_category": "product_category",
        "average_rating": "average_rating",
        "small_description": "small_description",
        "Title": "title",
        "Description": "description",
        "Reviews": "reviews",
        "Rating": "rating",
        "BulletPoints": "bullet_points",
        "Price": "price",
        "options": "options",
        "option_to_image": "option_to_image",
        "Attributes": "attributes",
        "instruction_text": "instruction_text",
        "instruction_attributes": "instruction_attributes",
        "MainImage": "main_image",
        "category": "category",
        "query": "query",
        "page": "page",
    }

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM all_products WHERE asin = ? LIMIT 1",
            (asin,),
        ).fetchone()

    if row is None:
        return None

    db_product = dict(row)
    origin_product = dict()
    for origin_k, db_k in key_map.items():
        origin_product[origin_k] = maybe_json(db_product[db_k])
    return origin_product


def get_top_n_product_from_keywords(keywords, search_engine):
    keywords = " ".join(keywords)
    hits = search_engine.search(keywords, k=SEARCH_RETURN_N)
    docs = [search_engine.doc(hit.docid) for hit in hits]
    top_n_asins = [json.loads(doc.raw())["id"] for doc in docs]
    # select in webshop.db
    top_n_products = [get_product_by_asin(asin) for asin in top_n_asins]
    # remove None
    top_n_products = [p for p in top_n_products if p is not None]
    return top_n_products


def get_product_per_page(top_n_products, page):
    return top_n_products[(page - 1) * PRODUCT_WINDOW : page * PRODUCT_WINDOW]


def generate_product_prices(all_products):
    product_prices = dict()
    for product in all_products:
        asin = product["asin"]
        pricing = product["pricing"]
        if not pricing:
            price = 100.0
        elif len(pricing) == 1:
            price = pricing[0]
        else:
            price = random.uniform(*pricing[:2])
        product_prices[asin] = price
    return product_prices


def init_search_engine():
    search_engine = LuceneSearcher(".cache/webshop/indexes")
    return search_engine


def clean_product_keys(products):
    for product in products:
        product.pop("product_information", None)
        product.pop("brand", None)
        product.pop("brand_url", None)
        product.pop("list_price", None)
        product.pop("availability_quantity", None)
        product.pop("availability_status", None)
        product.pop("total_reviews", None)
        product.pop("total_answered_questions", None)
        product.pop("seller_id", None)
        product.pop("seller_name", None)
        product.pop("fulfilled_by_amazon", None)
        product.pop("fast_track_message", None)
        product.pop("aplus_present", None)
        product.pop("small_description_old", None)
    print("Keys cleaned.")
    return products


def load_products(filepath, num_products=None, human_goals=True):
    # TODO: move to preprocessing step -> enforce single source of truth
    with open(filepath) as f:
        products = json.load(f)
    print("Products loaded.")
    products = clean_product_keys(products)

    # with open(DEFAULT_REVIEW_PATH) as f:
    #     reviews = json.load(f)
    all_reviews = dict()
    all_ratings = dict()
    # for r in reviews:
    #     all_reviews[r['asin']] = r['reviews']
    #     all_ratings[r['asin']] = r['average_rating']

    if human_goals:
        with open(HUMAN_ATTR_PATH) as f:
            human_attributes = json.load(f)
    with open(DEFAULT_ATTR_PATH) as f:
        attributes = json.load(f)
    with open(HUMAN_ATTR_PATH) as f:
        human_attributes = json.load(f)
    print("Attributes loaded.")

    asins = set()
    all_products = []
    attribute_to_asins = defaultdict(set)
    if num_products is not None:
        # using item_shuffle.json, we assume products already shuffled
        products = products[:num_products]
    for i, p in tqdm(enumerate(products), total=len(products)):
        asin = p["asin"]
        if asin == "nan" or len(asin) > 10:
            continue

        if asin in asins:
            continue
        else:
            asins.add(asin)

        products[i]["category"] = p["category"]
        products[i]["query"] = p["query"]
        products[i]["product_category"] = p["product_category"]

        products[i]["Title"] = p["name"]
        products[i]["Description"] = p["full_description"]
        products[i]["Reviews"] = all_reviews.get(asin, [])
        products[i]["Rating"] = all_ratings.get(asin, "N.A.")
        for r in products[i]["Reviews"]:
            if "score" not in r:
                r["score"] = r.pop("stars")
            if "review" not in r:
                r["body"] = ""
            else:
                r["body"] = r.pop("review")
        products[i]["BulletPoints"] = (
            p["small_description"]
            if isinstance(p["small_description"], list)
            else [p["small_description"]]
        )

        pricing = p.get("pricing")
        if pricing is None or not pricing:
            pricing = [100.0]
            price_tag = "$100.0"
        else:
            pricing = [
                float(Decimal(re.sub(r"[^\d.]", "", price)))
                for price in pricing.split("$")[1:]
            ]
            if len(pricing) == 1:
                price_tag = f"${pricing[0]}"
            else:
                price_tag = f"${pricing[0]} to ${pricing[1]}"
                pricing = pricing[:2]
        products[i]["pricing"] = pricing
        products[i]["Price"] = price_tag

        options = dict()
        customization_options = p["customization_options"]
        option_to_image = dict()
        if customization_options:
            for option_name, option_contents in customization_options.items():
                if option_contents is None:
                    continue
                option_name = option_name.lower()

                option_values = []
                for option_content in option_contents:
                    option_value = (
                        option_content["value"].strip().replace("/", " | ").lower()
                    )
                    option_image = option_content.get("image", None)

                    option_values.append(option_value)
                    option_to_image[option_value] = option_image
                options[option_name] = option_values
        products[i]["options"] = options
        products[i]["option_to_image"] = option_to_image

        # without color, size, price, availability
        # if asin in attributes and 'attributes' in attributes[asin]:
        #     products[i]['Attributes'] = attributes[asin]['attributes']
        # else:
        #     products[i]['Attributes'] = ['DUMMY_ATTR']
        # products[i]['instruction_text'] = \
        #     attributes[asin].get('instruction', None)
        # products[i]['instruction_attributes'] = \
        #     attributes[asin].get('instruction_attributes', None)

        # without color, size, price, availability
        if asin in attributes and "attributes" in attributes[asin]:
            products[i]["Attributes"] = attributes[asin]["attributes"]
        else:
            products[i]["Attributes"] = ["DUMMY_ATTR"]

        if human_goals:
            if asin in human_attributes:
                products[i]["instructions"] = human_attributes[asin]
        else:
            products[i]["instruction_text"] = attributes[asin].get("instruction", None)

            products[i]["instruction_attributes"] = attributes[asin].get(
                "instruction_attributes", None
            )

        products[i]["MainImage"] = p["images"][0]
        products[i]["query"] = p["query"].lower().strip()

        all_products.append(products[i])

    for p in all_products:
        for a in p["Attributes"]:
            attribute_to_asins[a].add(p["asin"])

    product_item_dict = {p["asin"]: p for p in all_products}
    product_prices = generate_product_prices(all_products)
    return all_products, product_item_dict, product_prices, attribute_to_asins
