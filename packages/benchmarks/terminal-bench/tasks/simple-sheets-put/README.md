# Sheets Clone API

A simple Google Sheets clone backend API built with FastAPI and PostgreSQL.

## Features

- Create and manage spreadsheets
- Create multiple sheets within a spreadsheet
- Update cell values
- Persistent storage with PostgreSQL

## Development Setup

### Local Development Environment

1. Create a virtual environment:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows use: .venv\Scripts\activate
   ```

2. Install dependencies:
   ```bash
   cd api
   pip install -r requirements.txt
   ```

3. Open the project in VSCode:
   ```bash
   code .
   ```
   VSCode will automatically detect the Python environment and provide proper intellisense and type checking.

### Running the Application

#### Using Docker (Recommended for Production)

1. Make sure you have Docker and Docker Compose installed
2. Run the application:
   ```bash
   docker-compose up --build
   ```
3. The API will be available at `http://localhost:8000`
4. Access the API documentation at `http://localhost:8000/docs`

#### Local Development Server

1. Make sure your virtual environment is activated
2. Run the development server:
   ```bash
   cd api
   uvicorn app.main:app --reload
   ```

## API Endpoints

- `POST /spreadsheets/` - Create a new spreadsheet
- `GET /spreadsheets/` - List all spreadsheets
- `GET /spreadsheets/{spreadsheet_id}` - Get a specific spreadsheet
- `POST /spreadsheets/{spreadsheet_id}/sheets/` - Create a new sheet in a spreadsheet
- `PUT /sheets/{sheet_id}/cells/{cell_id}` - Update a cell value
- `GET /sheets/{sheet_id}` - Get a specific sheet

## Data Structure

- Spreadsheets can contain multiple sheets
- Each sheet stores its cell data in a JSON format
- Cell IDs follow the format "A1", "B2", etc.

## Example Usage

1. Create a new spreadsheet:
   ```bash
   curl -X POST "http://localhost:8000/spreadsheets/" -H "Content-Type: application/json" -d '{"title": "My Spreadsheet"}'
   ```

2. Create a new sheet in the spreadsheet:
   ```bash
   curl -X POST "http://localhost:8000/spreadsheets/1/sheets/" -H "Content-Type: application/json" -d '{"title": "Sheet 1"}'
   ```

3. Update a cell value:
   ```bash
   curl -X PUT "http://localhost:8000/sheets/1/cells/A1" -H "Content-Type: application/json" -d '{"value": "Hello, World!"}'
   ```

## Development Notes

- We use `uv` for fast, deterministic Python package management
- Dependencies are locked in `requirements.lock` for reproducible builds
- For development, always install from `requirements.lock` to ensure consistent dependencies 