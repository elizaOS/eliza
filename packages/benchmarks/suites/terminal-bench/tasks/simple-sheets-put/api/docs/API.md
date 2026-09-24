# Sheets Clone API Documentation

## Overview

The Sheets Clone API provides a RESTful interface for managing spreadsheets and their data. It supports creating and managing spreadsheets, sheets, and cell data with features like pagination, batch operations, and rich cell formatting.

## Base URL

```
http://localhost:8000
```

## Authentication

Currently, the API does not require authentication.

## Endpoints

### Spreadsheets

#### Create a Spreadsheet
```http
POST /spreadsheets/
```

Creates a new spreadsheet.

**Request Body:**
```json
{
    "title": "My Spreadsheet"
}
```

**Response:** `200 OK`
```json
{
    "id": 1,
    "title": "My Spreadsheet",
    "created_at": "2024-02-26T10:00:00.000Z",
    "updated_at": "2024-02-26T10:00:00.000Z",
    "sheets": []
}
```

#### List Spreadsheets
```http
GET /spreadsheets/?page=1&size=10
```

Retrieves a paginated list of spreadsheets.

**Query Parameters:**
- `page` (integer, default: 1): Page number
- `size` (integer, default: 10, max: 100): Items per page

**Response:** `200 OK`
```json
{
    "items": [
        {
            "id": 1,
            "title": "My Spreadsheet",
            "created_at": "2024-02-26T10:00:00.000Z",
            "updated_at": "2024-02-26T10:00:00.000Z",
            "sheets": []
        }
    ],
    "total": 1,
    "page": 1,
    "size": 10,
    "pages": 1
}
```

#### Get a Spreadsheet
```http
GET /spreadsheets/{spreadsheet_id}
```

Retrieves a specific spreadsheet by ID.

**Response:** `200 OK`
```json
{
    "id": 1,
    "title": "My Spreadsheet",
    "created_at": "2024-02-26T10:00:00.000Z",
    "updated_at": "2024-02-26T10:00:00.000Z",
    "sheets": []
}
```

### Sheets

#### Create a Sheet
```http
POST /spreadsheets/{spreadsheet_id}/sheets/
```

Creates a new sheet in a spreadsheet.

**Request Body:**
```json
{
    "title": "Sheet 1",
    "data": {}
}
```

**Response:** `200 OK`
```json
{
    "id": 1,
    "title": "Sheet 1",
    "spreadsheet_id": 1,
    "data": {},
    "created_at": "2024-02-26T10:00:00.000Z",
    "updated_at": "2024-02-26T10:00:00.000Z"
}
```

#### List Sheets
```http
GET /spreadsheets/{spreadsheet_id}/sheets/?page=1&size=10
```

Retrieves a paginated list of sheets in a spreadsheet.

**Query Parameters:**
- `page` (integer, default: 1): Page number
- `size` (integer, default: 10, max: 100): Items per page

**Response:** `200 OK`
```json
{
    "items": [
        {
            "id": 1,
            "title": "Sheet 1",
            "spreadsheet_id": 1,
            "data": {},
            "created_at": "2024-02-26T10:00:00.000Z",
            "updated_at": "2024-02-26T10:00:00.000Z"
        }
    ],
    "total": 1,
    "page": 1,
    "size": 10,
    "pages": 1
}
```

#### Get a Sheet
```http
GET /sheets/{sheet_id}
```

Retrieves a specific sheet by ID.

**Response:** `200 OK`
```json
{
    "id": 1,
    "title": "Sheet 1",
    "spreadsheet_id": 1,
    "data": {},
    "created_at": "2024-02-26T10:00:00.000Z",
    "updated_at": "2024-02-26T10:00:00.000Z"
}
```

### Cell Operations

#### Update a Single Cell
```http
PUT /sheets/{sheet_id}/cells/{cell_id}
```

Updates the value and/or formatting of a single cell.

**Cell ID Format:**
- Must follow A1 notation (e.g., A1, B2, AA34)
- Column range: A to ZZ
- Row range: 1 to 9999

**Request Body:**
```json
{
    "value": "Hello World",
    "format": {
        "font_family": "Arial",
        "font_size": 12,
        "bold": true,
        "italic": false,
        "underline": false,
        "strikethrough": false,
        "text_color": "#000000",
        "background_color": "#FFFFFF",
        "horizontal_alignment": "left",
        "vertical_alignment": "middle",
        "text_wrap": false,
        "border_top": "1px solid black",
        "border_right": "1px solid black",
        "border_bottom": "1px solid black",
        "border_left": "1px solid black",
        "number_format": "0.00"
    }
}
```

All format properties are optional. Only specified properties will be updated.

**Response:** `200 OK`
```json
{
    "id": 1,
    "title": "Sheet 1",
    "spreadsheet_id": 1,
    "data": {
        "A1": {
            "value": "Hello World",
            "format": {
                "font_family": "Arial",
                "font_size": 12,
                "bold": true,
                "text_color": "#000000",
                "background_color": "#FFFFFF"
            }
        }
    },
    "created_at": "2024-02-26T10:00:00.000Z",
    "updated_at": "2024-02-26T10:00:00.000Z"
}
```

#### Batch Update Cells
```http
PUT /sheets/{sheet_id}/cells/batch
```

Updates multiple cells' values and/or formatting in a single request.

**Request Body:**
```json
{
    "updates": {
        "A1": {
            "value": "Header",
            "format": {
                "bold": true,
                "background_color": "#E0E0E0",
                "horizontal_alignment": "center"
            }
        },
        "B1": {
            "value": "123.45",
            "format": {
                "number_format": "#,##0.00",
                "horizontal_alignment": "right"
            }
        },
        "C1": {
            "format": {
                "text_color": "#FF0000"
            }
        }
    }
}
```

**Response:** `200 OK`
```json
{
    "success": true,
    "message": "Successfully updated 3 cells",
    "failed_operations": null
}
```

**Error Response:** `200 OK` (with failures)
```json
{
    "success": false,
    "message": "Invalid cell IDs found",
    "failed_operations": {
        "AAA1": "Column identifier too large (maximum is ZZ)",
        "1A": "Cell ID must be in A1 notation (e.g., A1, B2, AA1)"
    }
}
```

## Cell Formatting Options

The API supports rich cell formatting with the following options:

### Font Properties
- `font_family`: Font name (e.g., "Arial", "Times New Roman")
- `font_size`: Font size in points (e.g., 10, 12, 14)
- `bold`: Boolean for bold text
- `italic`: Boolean for italic text
- `underline`: Boolean for underlined text
- `strikethrough`: Boolean for strikethrough text

### Colors
- `text_color`: Text color in hex format (e.g., "#000000" for black)
- `background_color`: Cell background color in hex format (e.g., "#FFFFFF" for white)

### Alignment
- `horizontal_alignment`: Text horizontal alignment
  - Values: "left", "center", "right"
- `vertical_alignment`: Text vertical alignment
  - Values: "top", "middle", "bottom"
- `text_wrap`: Boolean for text wrapping

### Borders
Each border property accepts a CSS-style border string:
- `border_top`
- `border_right`
- `border_bottom`
- `border_left`

Example: "1px solid black", "2px dashed red"

### Number Formatting
- `number_format`: Format pattern for numbers and dates
  - Examples:
    - "0.00" - Two decimal places
    - "#,##0" - Thousands separator
    - "MM/DD/YYYY" - Date format
    - "HH:mm:ss" - Time format
    - "$#,##0.00" - Currency format

## Error Responses

### 404 Not Found
```json
{
    "detail": "Spreadsheet not found"
}
```

### 400 Bad Request
```json
{
    "detail": "Cell ID must be in A1 notation (e.g., A1, B2, AA1)"
}
```

## Cell ID Validation Rules

1. Format: Letter(s) followed by number (e.g., A1, B2, AA34)
2. Column limitations:
   - Must be 1-2 uppercase letters (A-Z)
   - Maximum column is ZZ (702 columns)
3. Row limitations:
   - Must be a positive number
   - Maximum row is 9999
4. Examples:
   - Valid: A1, B2, Z9, AA1, ZZ999
   - Invalid: 1A, A0, AAA1, A-1, 11 