"""
Functions for specifying goals and reward calculations.
"""

import itertools
import random
from collections import defaultdict

import spacy
from rich import print
from thefuzz import fuzz

from gem.envs.webshop.web_agent_site.engine.normalize import normalize_color

nlp = spacy.load("en_core_web_sm")

PRICE_RANGE = [10.0 * i for i in range(1, 100)]


def get_goals(all_products, product_prices, human_goals=True):
    if human_goals:
        return get_human_goals(all_products, product_prices)
    else:
        return get_synthetic_goals(all_products, product_prices)


def get_human_goals(all_products, product_prices):
    goals = []
    cnt_atts = defaultdict(int)
    cnt = 0
    for item in all_products:
        asin = item["asin"]
        if "instruction_text" not in item:
            continue
        for product in item["instruction_text"]:
            attributes = product["instruction_attributes"]
            if len(attributes) == 0:
                cnt += 1
                continue

            if product_prices is not None:
                price = product_prices[asin]
                price_range = [p for p in PRICE_RANGE if p > price][:4]
                if len(price_range) >= 2:
                    _, price_upper = sorted(random.sample(price_range, 2))
                    price_text = f", and price lower than {price_upper:.2f} dollars"
                else:
                    price_upper = 1000000
                    price_text = ""
            else:
                price_upper = 1000000

            goals.append(
                {
                    "asin": asin,
                    "category": item["category"],
                    "query": item["query"],
                    "name": item["name"],
                    "product_category": item["product_category"],
                    "instruction_text": product["instruction_text"].strip(".")
                    + price_text,
                    "attributes": attributes,
                    "price_upper": price_upper,
                    "goal_options": product["instruction_options"],
                }
            )
            for att in attributes:
                cnt_atts[att] += 1
            # goals += product_goals
    for goal in goals:
        goal["weight"] = 1
    print(cnt, "skipped")
    return goals


def get_synthetic_goals(all_products, product_prices):
    goals = []
    cnt_atts = defaultdict(int)
    for product in all_products:
        if "instruction_text" not in product or product["instruction_text"] is None:
            continue
        product_goals = []
        asin = product["asin"]
        attributes = product["instruction_attributes"]
        assert len(attributes) > 0

        if product_prices is not None:
            price = product_prices[asin]
            price_range = [p for p in PRICE_RANGE if p > price][:4]
            if len(price_range) >= 2:
                _, price_upper = sorted(random.sample(price_range, 2))
                price_text = f", and price lower than {price_upper:.2f} dollars"
            else:
                price_upper = 1000000
                price_text = ""
        else:
            price_upper = 1000000
            price_text = ""

        instruction_text = product["instruction_text"]

        options = product["options"]
        option_names = sorted(options)
        combinations = list(
            itertools.product(*(options[option_name] for option_name in option_names))
        )
        for combination in combinations:
            goal_options = dict()
            for i, o in enumerate(combination):
                #                option_text.append(f'{option_names[i]}: {o}')
                goal_options[option_names[i]] = o
            option_text = ", and ".join([f"{k}: {v}" for k, v in goal_options.items()])
            option_text = " with " + option_text if option_text else ""
            product_goals.append(
                {
                    "asin": asin,
                    "category": product["category"],
                    "query": product["query"],
                    "name": product["name"],
                    "product_category": product["product_category"],
                    "instruction_text": f"{instruction_text}{option_text}{price_text}",
                    "attributes": attributes,
                    "price_upper": price_upper,
                    "goal_options": goal_options,
                    "name": product["Title"],
                }
            )
            for att in attributes:
                cnt_atts[att] += 1
        goals += product_goals
    for goal in goals:
        goal["weight"] = sum(1.0 / cnt_atts[att] for att in goal["attributes"]) / len(
            goal["attributes"]
        )
    return goals


def get_type_reward(purchased_product, goal):
    """Determines the type reward - captures whether chosen product is in the same category"""
    query_match = purchased_product["query"] == goal["query"]

    # Check number of unique categories that match, ignoring order
    purchased_product_category = [
        x.strip() for x in purchased_product["product_category"].split("›")
    ]
    goal_product_category = [x.strip() for x in goal["product_category"].split("›")]
    category_match = (
        len(set(purchased_product_category) & set(goal_product_category)) >= 2
    )

    # Determine whether types align based on product name similarity
    purchased_type = purchased_product["name"]
    desired_type = goal["name"]

    purchased_type_parse = nlp(purchased_type)
    desired_type_parse = nlp(desired_type)

    purchased_type_parse = [
        t.text.lower()
        for t in purchased_type_parse
        if t.pos_ in ("PNOUN", "NOUN", "PROPN")
    ]
    desired_type_parse = [
        t.text.lower()
        for t in desired_type_parse
        if t.pos_ in ("PNOUN", "NOUN", "PROPN")
    ]

    n_intersect_type = len(set(purchased_type_parse) & set(desired_type_parse))
    if len(desired_type_parse) == 0:
        title_score = 0.2
    else:
        title_score = n_intersect_type / len(desired_type_parse)

    r_type = 1.0

    # Adjust r_type score based on query, category title matching/scores
    match = query_match or category_match or title_score > 0.2
    if not match:
        r_type = 0.5

    if title_score < 0.1:
        r_type = 0.1

    if title_score == 0.0:
        r_type = 0.0

    return dict(
        r_type=r_type,
        query_match=query_match,
        category_match=category_match,
        title_score=title_score,
    )


def get_attribute_reward(purchased_product, goal):
    """Determines whether purchased products shares same attributes as goal"""
    purchased_attrs = purchased_product["Attributes"]
    goal_attrs = goal["attributes"]

    num_attr_matches = 0
    for g_attr in goal_attrs:
        matched = False
        # Check whether goal attribute found in purchased product attribute list
        for p_attr in purchased_attrs:
            score = fuzz.token_set_ratio(p_attr, g_attr)
            if score > 85:
                num_attr_matches += 1
                matched = True
                break
        # If not in purchased attrs, check Title, Bullet Points (Features), Desc
        if not matched and (
            g_attr in purchased_product["Title"].lower()
            or g_attr in " ".join(purchased_product["BulletPoints"]).lower()
            or g_attr in purchased_product["Description"].lower()
        ):
            num_attr_matches += 1
            matched = True

    r_attr = num_attr_matches / len(goal_attrs)
    return r_attr, num_attr_matches


def get_option_reward(purchased_options, goal_options):
    """Calculate reward for purchased product's options w.r.t. goal options"""
    purchased_options = [normalize_color(o) for o in purchased_options]
    goal_options = [normalize_color(o) for o in goal_options]

    # Perform fuzzy matching of each purchased option against each goal option
    num_option_matches = 0
    for g_option in goal_options:
        for p_option in purchased_options:
            score = fuzz.token_set_ratio(p_option, g_option)
            if score > 85:
                num_option_matches += 1
                break

    # Calculate option reward as fraction of goal options hit
    r_option = num_option_matches / len(goal_options) if len(goal_options) > 0 else None
    return r_option, num_option_matches


def get_reward(purchased_product, goal, price, options, **kwargs):
    """Get cumulative reward score for purchased product and goal"""
    r_type_dict = get_type_reward(purchased_product, goal)

    r_price = (price <= goal["price_upper"]) if goal["price_upper"] > 0 else None

    r_att, num_attr_matches = get_attribute_reward(purchased_product, goal)

    r_option, num_option_matches = get_option_reward(
        list(options.values()),
        (
            goal["goal_options"].items()
            if isinstance(goal["goal_options"], dict)
            else goal["goal_options"]
        ),
    )

    total_reward = (num_attr_matches + num_option_matches + r_price) / (
        len(goal["attributes"]) + len(goal["goal_options"]) + 1
    )

    total_reward *= r_type_dict["r_type"]

    # If verbose flag enabled, store score sub-components into dictionary
    if kwargs.get("verbose", False):
        info = {
            "r_type": r_type_dict["r_type"],
            "r_att": r_att,
            "w_att": len(goal["attributes"])
            / (len(goal["attributes"]) + len(goal["goal_options"]) + 1),
            "query_match": r_type_dict["query_match"],
            "category_match": r_type_dict["category_match"],
            "title_score": r_type_dict["title_score"],
        }
        if r_option is not None:
            info["r_option"] = r_option
            info["w_option"] = len(goal["goal_options"]) / (
                len(goal["attributes"]) + len(goal["goal_options"]) + 1
            )
        if r_price is not None:
            info["r_price"] = r_price
            info["w_price"] = 1 / (
                len(goal["attributes"]) + len(goal["goal_options"]) + 1
            )
        return total_reward, info
    return total_reward
