"""Install operator modules under one namespace; keep tests in the checkout."""

from setuptools import find_namespace_packages, setup
from setuptools.command.build_py import build_py


class OperatorBuild(build_py):
    def find_package_modules(self, package, package_dir):
        return [
            module
            for module in super().find_package_modules(package, package_dir)
            if not module[1].startswith("test_") and module[1] != "conftest"
        ]


setup(
    packages=[
        "eliza_training",
        *[
            f"eliza_training.{name}"
            for name in find_namespace_packages(
                where="scripts", exclude=["*__tests__*"]
            )
        ],
    ],
    package_dir={"eliza_training": "scripts"},
    package_data={"": ["*.json", "*.yaml", "*.j2", "*.txt", "*.md", "*.jsonl"]},
    cmdclass={"build_py": OperatorBuild},
)
