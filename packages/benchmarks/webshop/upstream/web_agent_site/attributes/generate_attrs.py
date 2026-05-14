import json
import yaml
import random
from pathlib import Path
from collections import defaultdict

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.feature_extraction import text as sk_text
import pandas as pd
from tqdm import tqdm
from rich import print

ITEMS_PATH = './data/ITEMS_mar1.json'
REVIEWS_PATH = './data/reviews.json'
ATTR_DIR = './data/attributes'

random.seed(0)


def get_stop_words():
    extra_stop_words = set([str(i) for i in range(1000)])
    stop_words = sk_text.ENGLISH_STOP_WORDS.union(extra_stop_words)
    return stop_words


def load_products(num=None):
    """
    Loads products from the `items.json` file and combine them with reviews
    through `asin`.
    Return: dict[asin, product]
    """
    with open(ITEMS_PATH) as f:
        all_products = json.load(f)
        if num is not None:
            random.shuffle(all_products)
            all_products = all_products[:num]
        products = dict()
        asins = set()
        for p in all_products:
            asin = p['asin']
            if asin in asins:
                continue
            asins.add(asin)
            products[asin] = p

    with open(REVIEWS_PATH) as f:
        reviews = json.load(f)
        reviews = {r['asin']: r for r in reviews}

    for asin, p in products.items():
        if asin in reviews:
            p['review'] = reviews[asin]
        else:
            p['review'] = None
    return products


def get_top_attrs(attributes, k):
    attr_to_asins = defaultdict(list)

    for asin, attr_scores in attributes.items():
        top_attr_scoress = attr_scores[:k]
        for attr, score in top_attr_scoress:
            attr_to_asins[attr].append(asin)
    total = len([asin for asin, _ in attributes.items()])
    
    top_attrs = [
        (attr, len(asins) / total)
        for attr, asins in attr_to_asins.items()
    ]
    top_attrs = sorted(top_attrs, key=lambda x: -x[1])
    top_attrs = [f'{attr} | {score:.4f}' for attr, score in top_attrs]
    return top_attrs


def get_corpus(
        products,
        keys=('name', 'small_description'),
        category_type='category'
    ):
    """
    keys: `name`, `small_description`, `review`
    category_type: `category`, `query`
    """
    all_products = list(products.values())
    
    asins_by_cat = defaultdict(set)
    corpus_by_cat = defaultdict(list)
    for p in all_products:
        category = p[category_type]
        asin = p['asin']
        if asin in asins_by_cat[category]:
            continue
        asins_by_cat[category].add(asin)

        text = []
        for key in keys:
            if key == 'review':
                rs = p['review']['reviews']
                if r is not None:
                    text_ = ' '.join([r['review'].lower() for r in rs])
                else:
                    text_ = ''
            else:
                text_ = p[key].lower()
            text.append(text_)
        text = ' '.join(text)
        corpus_by_cat[category].append((asin, text))
    return corpus_by_cat


def generate_ngram_attrs(corpus_by_cat, ngram_range, k, attrs):
    vectorizer = TfidfVectorizer(
        stop_words=get_stop_words(),
        ngram_range=ngram_range,
        max_features=1000,
    )

    top_attrs_by_cat = dict()
    for category, corpus in tqdm(corpus_by_cat.items(),
                                 total=len(corpus_by_cat)):
        asins = [_[0] for _ in corpus]
        texts = [_[1] for _ in corpus]
        vec = vectorizer.fit_transform(texts).todense()
        df = pd.DataFrame(vec, columns=vectorizer.get_feature_names_out())

        attrs_by_cat = dict()
        for asin, (row_name, row) in zip(asins, df.iterrows()):
            attr_scores = sorted(
                list(zip(row.index, row)),
                key=lambda x: -x[1]
            )
            attrs_by_cat[asin] = attr_scores
            attrs[asin] = attr_scores
        top_attrs_by_cat[category.lower()] = get_top_attrs(attrs_by_cat, k=k)
    print(top_attrs_by_cat.keys())
    return top_attrs_by_cat


def generate_attrs(corpus_by_cat, k, save_name):
    attrs = dict()
    for n in range(1, 3):
        ngram_range = (n, n)
        top_attrs_by_cat = \
            generate_ngram_attrs(corpus_by_cat, ngram_range, k, attrs)

        if save_name is not None:
            save_path = Path(ATTR_DIR) / f'{save_name}_{n}-gram.yaml'
            with open(save_path, 'w') as f:
                yaml.dump(top_attrs_by_cat, f, default_flow_style=False)
            print(f'Saved: {save_path}')

    save_path = Path(ATTR_DIR) / f'{save_name}_attrs_unfiltered.json'
    with open(save_path, 'w') as f:
        json.dump(attrs, f)
    print(f'Saved: {save_path}')


if __name__ == '__main__':
    """
    python -m web_agent_site.attributes.generate_attrs

    Inspect in notebooks/attributes.ipynb.
    """
    products = load_products(num=40000)

    corpus_by_cat_broad = get_corpus(products, category_type='category')
    generate_attrs(corpus_by_cat_broad, k=5, save_name='broad')

    corpus_by_cat_narrow = get_corpus(products, category_type='query')
    generate_attrs(corpus_by_cat_narrow, k=5, save_name='narrow')
