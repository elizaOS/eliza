import yaml
from pathlib import Path
from rich import print

ATTR_DIR = './data/attributes'

ATTR_PATHS = [
    'narrow_2-gram.yaml',
    'narrow_1-gram.yaml',
    'broad_2-gram.yaml',
    'broad_1-gram.yaml',
]
ATTR_PATHS = [Path(ATTR_DIR) / af for af in ATTR_PATHS]


def annotate(attr_path):
    with open(attr_path) as f:
        attrs_by_cat = yaml.safe_load(f)

    unique_attrs = set()
    all_attrs = []
    for _, attrs in attrs_by_cat.items():
        attrs = [a.split('|')[0].strip() for a in attrs]
        unique_attrs.update(attrs)
        all_attrs += attrs
    print(f'Total unique attributes: {len(unique_attrs)}')
    total = len(all_attrs)
    num_left = len(all_attrs)

    annotated_attrs_by_cat = dict()
    for category, attrs in attrs_by_cat.items():
        print(
            f'Category: [ {category} ] | '
            f'Number of attributes: {len(attrs)}\n'
        )
        annotated_attrs = []
        for i, attr in enumerate(attrs):
            attr, score = attr.split(' | ')
            print(
                f'{"[" + str(i) + "]":<5} '
                f'[bold green]{attr:<30}[/bold green] | '
                f'[red]{category}[/red] | '
                f'{score}'
            )
            tags = input(
                'Annotate [1: ITEM, 2: PROP, 3: USE, '
                '⎵: next example, q: next category] > '
            )
            print('\n')
            tags = tags.strip()
            annotated_attrs.append(f'{attr} | {score} | {tags}')
            if 'q' in tags:
                break
        
        num_left -= len(attrs)
        print(f'{num_left} / {total} total attributes left.')

        ans = input('Starting the next category... [y/n] > ')
        if ans == 'n':
            break

def main():
    for attr_path in ATTR_PATHS:
        annotate(attr_path)

if __name__ == '__main__':
    """
    python -m web_agent_site.attributes.annotate
    """
    main()
