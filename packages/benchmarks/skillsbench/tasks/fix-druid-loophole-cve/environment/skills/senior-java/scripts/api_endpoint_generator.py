#!/usr/bin/env python3
"""
API Endpoint Generator
Scaffold RESTful API endpoints with validation and documentation.

Features:
- CRUD endpoint generation
- Request/response DTOs
- Jakarta validation annotations
- OpenAPI annotations
- Pagination support
- Error handling

Standard library only - no external dependencies required.
"""

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

__version__ = "1.0.0"


def generate_controller(resource: str, methods: List[str], paginated: bool, package: str) -> str:
    """Generate REST controller code"""
    resource_pascal = resource[0].upper() + resource[1:]
    resource_camel = resource[0].lower() + resource[1:]
    endpoint = resource.lower() + "s"

    method_impls = []

    if "GET" in methods:
        if paginated:
            method_impls.append(f'''
    @GetMapping
    @Operation(summary = "Get all {resource_pascal} entities with pagination")
    public ResponseEntity<Page<{resource_pascal}DTO>> findAll(Pageable pageable) {{
        return ResponseEntity.ok({resource_camel}Service.findAll(pageable));
    }}

    @GetMapping("/{{id}}")
    @Operation(summary = "Get a {resource_pascal} by ID")
    public ResponseEntity<{resource_pascal}DTO> findById(@PathVariable Long id) {{
        return ResponseEntity.ok({resource_camel}Service.findById(id));
    }}''')
        else:
            method_impls.append(f'''
    @GetMapping
    @Operation(summary = "Get all {resource_pascal} entities")
    public ResponseEntity<List<{resource_pascal}DTO>> findAll() {{
        return ResponseEntity.ok({resource_camel}Service.findAll());
    }}

    @GetMapping("/{{id}}")
    @Operation(summary = "Get a {resource_pascal} by ID")
    public ResponseEntity<{resource_pascal}DTO> findById(@PathVariable Long id) {{
        return ResponseEntity.ok({resource_camel}Service.findById(id));
    }}''')

    if "POST" in methods:
        method_impls.append(f'''
    @PostMapping
    @Operation(summary = "Create a new {resource_pascal}")
    public ResponseEntity<{resource_pascal}DTO> create(@Valid @RequestBody {resource_pascal}DTO dto) {{
        return ResponseEntity.status(HttpStatus.CREATED)
            .body({resource_camel}Service.create(dto));
    }}''')

    if "PUT" in methods:
        method_impls.append(f'''
    @PutMapping("/{{id}}")
    @Operation(summary = "Update an existing {resource_pascal}")
    public ResponseEntity<{resource_pascal}DTO> update(
            @PathVariable Long id,
            @Valid @RequestBody {resource_pascal}DTO dto) {{
        return ResponseEntity.ok({resource_camel}Service.update(id, dto));
    }}''')

    if "PATCH" in methods:
        method_impls.append(f'''
    @PatchMapping("/{{id}}")
    @Operation(summary = "Partially update a {resource_pascal}")
    public ResponseEntity<{resource_pascal}DTO> partialUpdate(
            @PathVariable Long id,
            @RequestBody Map<String, Object> updates) {{
        return ResponseEntity.ok({resource_camel}Service.partialUpdate(id, updates));
    }}''')

    if "DELETE" in methods:
        method_impls.append(f'''
    @DeleteMapping("/{{id}}")
    @Operation(summary = "Delete a {resource_pascal}")
    public ResponseEntity<Void> delete(@PathVariable Long id) {{
        {resource_camel}Service.delete(id);
        return ResponseEntity.noContent().build();
    }}''')

    imports = f'''package {package}.controller;

import {package}.dto.{resource_pascal}DTO;
import {package}.service.{resource_pascal}Service;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;'''

    if paginated:
        imports += "\nimport org.springframework.data.domain.Page;\nimport org.springframework.data.domain.Pageable;"
    else:
        imports += "\nimport java.util.List;"

    if "PATCH" in methods:
        imports += "\nimport java.util.Map;"

    imports += '''
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;'''

    return f'''{imports}

@RestController
@RequestMapping("/api/{endpoint}")
@RequiredArgsConstructor
@Tag(name = "{resource_pascal}", description = "{resource_pascal} management APIs")
public class {resource_pascal}Controller {{

    private final {resource_pascal}Service {resource_camel}Service;
{"".join(method_impls)}
}}
'''


def main():
    parser = argparse.ArgumentParser(
        description="API Endpoint Generator - Scaffold REST controllers",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full CRUD endpoints
  python api_endpoint_generator.py orders --methods GET,POST,PUT,DELETE

  # Read-only with pagination
  python api_endpoint_generator.py reports --methods GET --paginated

  # Custom package
  python api_endpoint_generator.py products --methods GET,POST --package com.myapp
"""
    )

    parser.add_argument("resource", help="Resource name (e.g., order, product)")
    parser.add_argument("--methods", default="GET,POST,PUT,DELETE",
                        help="HTTP methods (default: GET,POST,PUT,DELETE)")
    parser.add_argument("--paginated", action="store_true",
                        help="Enable pagination for GET endpoints")
    parser.add_argument("--package", default="com.example",
                        help="Package name (default: com.example)")
    parser.add_argument("--output", "-o", help="Output file path")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    args = parser.parse_args()
    methods = [m.strip().upper() for m in args.methods.split(',')]

    code = generate_controller(args.resource, methods, args.paginated, args.package)

    result = {
        "resource": args.resource,
        "methods": methods,
        "paginated": args.paginated,
        "package": args.package,
    }

    if args.output:
        Path(args.output).write_text(code)
        result["output_file"] = args.output
        print(f"Controller generated: {args.output}")
    elif args.json:
        result["code"] = code
        print(json.dumps(result, indent=2))
    else:
        print(code)


if __name__ == "__main__":
    main()
