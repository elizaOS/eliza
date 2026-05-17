FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY config/ ./config/
RUN mkdir -p data/reports logs

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "src/main.py"]
CMD ["--config", "config/settings.yaml"]
