"""Setup file for ElizaOS RL training with Atropos."""

from setuptools import setup, find_packages

setup(
    name="elizaos-training",
    version="1.0.0",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    python_requires=">=3.10",
    install_requires=[
        "atroposlib>=0.3.0",
        "asyncpg>=0.29.0",
        "python-dotenv>=1.0.0",
        "pydantic>=2.0.0",
        "openai>=1.0.0",
        "torch>=2.1.0",
        "transformers>=4.36.0",
    ],
)
