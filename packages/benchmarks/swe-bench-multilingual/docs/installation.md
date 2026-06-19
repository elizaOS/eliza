# Installation

SWE-bench is designed to be easy to install and run on most systems with Docker support.

## Prerequisites

Before installing SWE-bench, make sure you have the following prerequisites:

* **Python 3.9+** - Required for running the package
* **Docker** - Essential for the evaluation environment

## Standard Installation

For most users, the standard installation is the best option:

```bash
# Clone the repository
git clone https://github.com/princeton-nlp/SWE-bench.git
cd SWE-bench

# Install the package
pip install -e .
```

This will install the package in development mode, allowing you to make changes to the code if needed.

### Install dependencies for dataset generation or RAG inference

To install the dependencies for dataset generation, you can run the following command:
```bash
pip install -e ".[make_datasets]"
```

To install the dependencies for inference and dataset generation, you can run the following command:
```bash
pip install -e ".[inference]"
```

## Docker Setup

SWE-bench relies heavily on Docker for its evaluation environment. Make sure Docker is correctly installed and running:

```bash
# Test that Docker is installed correctly
docker --version
docker run hello-world
```

## Optional Dependencies

Depending on your use case, you might want to install additional dependencies:

```bash
# For using SWE-Llama models locally
pip install -e ".[llama]"

# For development and testing
pip install -e ".[dev]"
```

## Cloud Installation (Modal)

For running evaluations in the cloud using Modal:

```bash
pip install modal
modal setup  # First-time setup only
pip install -e ".[modal]"
```

## Troubleshooting

If you encounter any issues during installation:

1. **Docker permission issues**: You might need to add your user to the Docker group
2. **Python version conflicts**: Make sure you're using Python 3.9+
3. **Package conflicts**: Consider using a virtual environment

For more detailed troubleshooting, please refer to our [FAQ page](faq.md) or open an issue on GitHub. 