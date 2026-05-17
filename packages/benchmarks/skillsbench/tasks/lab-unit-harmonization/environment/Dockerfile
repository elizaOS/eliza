FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages (base + task-specific)
RUN pip install --no-cache-dir \
    numpy==1.26.4 \
    pandas==2.2.2 \
    scipy==1.13.1 \
    matplotlib==3.9.0 \
    pytest \
    pytest-json-ctrf

WORKDIR /root

# Copy data files
COPY data /root/environment/data
