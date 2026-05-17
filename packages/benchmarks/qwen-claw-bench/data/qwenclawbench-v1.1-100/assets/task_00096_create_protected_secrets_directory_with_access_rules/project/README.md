# DataPipeline

A data processing pipeline for aggregating and transforming customer analytics data.

## Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your credentials
3. Run `docker-compose up -d`
4. Run migrations: `python manage.py migrate`

## Configuration

See `config.json` for application settings. Sensitive credentials should go in `.env` (never committed).

## Architecture

- **Ingestion**: Kafka consumer pulls events from upstream
- **Processing**: Python workers transform and enrich data  
- **Storage**: PostgreSQL for structured data, S3 for raw files
- **API**: FastAPI service exposes processed data

## Deployment

Secrets are managed via AWS Secrets Manager in production. For local development, use `.env` files.

## Team

- Sarah Chen - Backend Lead
- Jake Morrison - DevOps
- Alex Rivera - Data Engineering
