# !bin/bash

python -m build

python -m twine upload --skip-existing --repository pypi dist/*
# python -m twine upload --skip-existing --repository testpypi dist/*
