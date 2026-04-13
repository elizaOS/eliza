FROM python:3.9-slim

WORKDIR /app/monitor

# Install dependencies
COPY monitor/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Expose port (will be overridden by environment variable)
ARG FLASK_PORT=8080
EXPOSE ${FLASK_PORT}

# Command to run the application
CMD ["python", "main.py"]
