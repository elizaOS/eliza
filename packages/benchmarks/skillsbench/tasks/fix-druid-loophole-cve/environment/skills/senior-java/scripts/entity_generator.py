#!/usr/bin/env python3
"""
JPA Entity Generator
Generate complete JPA entity stacks with repository, service, controller, and DTO.

Features:
- JPA entity with Lombok annotations
- Spring Data JPA repository with custom queries
- Service layer with transaction management
- REST controller with validation
- DTO and mapper (MapStruct)
- Relationship support (OneToMany, ManyToOne, ManyToMany)

Standard library only - no external dependencies required.
"""

import argparse
import json
import logging
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

__version__ = "1.0.0"


@dataclass
class FieldDefinition:
    """Definition of an entity field"""
    name: str
    java_type: str
    nullable: bool = True
    unique: bool = False
    column_name: Optional[str] = None


@dataclass
class RelationDefinition:
    """Definition of an entity relationship"""
    field_name: str
    relation_type: str  # OneToMany, ManyToOne, ManyToMany, OneToOne
    target_entity: str
    mapped_by: Optional[str] = None
    cascade: bool = True
    fetch_lazy: bool = True


@dataclass
class EntityConfig:
    """Configuration for entity generation"""
    name: str
    fields: List[FieldDefinition]
    relations: List[RelationDefinition] = field(default_factory=list)
    package_name: str = "com.example"
    auditable: bool = False
    soft_delete: bool = False
    table_name: Optional[str] = None

    def __post_init__(self):
        if not self.table_name:
            # Convert CamelCase to snake_case for table name
            self.table_name = re.sub(r'(?<!^)(?=[A-Z])', '_', self.name).lower()


class EntityGenerator:
    """
    JPA Entity Generator for creating complete entity stacks.
    """

    JAVA_TYPE_IMPORTS = {
        "Long": None,
        "Integer": None,
        "String": None,
        "Boolean": None,
        "Double": None,
        "Float": None,
        "BigDecimal": "java.math.BigDecimal",
        "LocalDate": "java.time.LocalDate",
        "LocalDateTime": "java.time.LocalDateTime",
        "LocalTime": "java.time.LocalTime",
        "Instant": "java.time.Instant",
        "UUID": "java.util.UUID",
        "List": "java.util.List",
        "Set": "java.util.Set",
    }

    def __init__(self, config: EntityConfig, output_dir: str, verbose: bool = False):
        if verbose:
            logging.getLogger().setLevel(logging.DEBUG)
        logger.debug("EntityGenerator initialized")

        self.config = config
        self.output_dir = Path(output_dir)
        self.verbose = verbose
        self.files_created: List[str] = []

    def generate(self) -> Dict[str, Any]:
        """Generate all entity-related files"""
        logger.debug(f"Generating entity: {self.config.name}")
        if self.verbose:
            print(f"Generating entity stack for: {self.config.name}")
            print(f"Package: {self.config.package_name}")
            print(f"Fields: {len(self.config.fields)}")
            print(f"Relations: {len(self.config.relations)}")
            print(f"Output: {self.output_dir}\n")

        # Create directory structure
        self._create_directories()

        # Generate files
        self._generate_entity()
        self._generate_repository()
        self._generate_service()
        self._generate_controller()
        self._generate_dto()
        self._generate_mapper()

        return self._generate_report()

    def _create_directories(self):
        """Create package directories"""
        package_path = self.config.package_name.replace('.', '/')
        directories = [
            f"src/main/java/{package_path}/entity",
            f"src/main/java/{package_path}/repository",
            f"src/main/java/{package_path}/service",
            f"src/main/java/{package_path}/controller",
            f"src/main/java/{package_path}/dto",
            f"src/main/java/{package_path}/mapper",
        ]
        for directory in directories:
            (self.output_dir / directory).mkdir(parents=True, exist_ok=True)

    def _generate_entity(self):
        """Generate JPA entity class"""
        package_path = self.config.package_name.replace('.', '/')
        imports = self._collect_entity_imports()

        # Build field declarations
        field_decls = []
        for f in self.config.fields:
            annotations = []
            if f.name == "id":
                annotations.append("@Id")
                annotations.append("@GeneratedValue(strategy = GenerationType.IDENTITY)")
            if not f.nullable and f.name != "id":
                annotations.append(f'@Column(nullable = false{", unique = true" if f.unique else ""})')
            elif f.unique:
                annotations.append("@Column(unique = true)")

            annotation_str = "\n    ".join(annotations)
            if annotation_str:
                annotation_str = "    " + annotation_str + "\n"
            field_decls.append(f"{annotation_str}    private {f.java_type} {f.name};")

        # Build relationship declarations
        relation_decls = []
        for r in self.relations_sorted():
            annotations = []
            fetch = "FetchType.LAZY" if r.fetch_lazy else "FetchType.EAGER"
            cascade = ", cascade = CascadeType.ALL" if r.cascade else ""

            if r.relation_type == "ManyToOne":
                annotations.append(f"@ManyToOne(fetch = {fetch})")
                annotations.append(f'@JoinColumn(name = "{self._to_snake_case(r.field_name)}_id")')
            elif r.relation_type == "OneToMany":
                mapped = f', mappedBy = "{r.mapped_by}"' if r.mapped_by else ""
                annotations.append(f"@OneToMany(fetch = {fetch}{cascade}{mapped})")
            elif r.relation_type == "ManyToMany":
                annotations.append(f"@ManyToMany(fetch = {fetch}{cascade})")
            elif r.relation_type == "OneToOne":
                annotations.append(f"@OneToOne(fetch = {fetch}{cascade})")

            annotation_str = "\n    ".join(annotations)
            if annotation_str:
                annotation_str = "    " + annotation_str + "\n"

            java_type = r.target_entity
            if r.relation_type in ["OneToMany", "ManyToMany"]:
                java_type = f"List<{r.target_entity}>"

            relation_decls.append(f"{annotation_str}    private {java_type} {r.field_name};")

        # Audit fields
        audit_fields = ""
        if self.config.auditable:
            audit_fields = """
    @CreatedDate
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @LastModifiedDate
    @Column(nullable = false)
    private LocalDateTime updatedAt;

    @CreatedBy
    @Column(updatable = false)
    private String createdBy;

    @LastModifiedBy
    private String updatedBy;
"""

        # Soft delete field
        soft_delete = ""
        if self.config.soft_delete:
            soft_delete = """
    @Column(nullable = false)
    private boolean deleted = false;

    private LocalDateTime deletedAt;
"""

        entity_listener = ""
        if self.config.auditable:
            entity_listener = "@EntityListeners(AuditingEntityListener.class)\n"

        content = f'''package {self.config.package_name}.entity;

{imports}

@Entity
@Table(name = "{self.config.table_name}")
{entity_listener}@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class {self.config.name} {{

{chr(10).join(field_decls)}
{chr(10).join(relation_decls)}{audit_fields}{soft_delete}}}
'''
        self._write_file(f"src/main/java/{package_path}/entity/{self.config.name}.java", content)

    def _generate_repository(self):
        """Generate Spring Data JPA repository"""
        package_path = self.config.package_name.replace('.', '/')

        # Find ID type
        id_type = "Long"
        for f in self.config.fields:
            if f.name == "id":
                id_type = f.java_type
                break

        content = f'''package {self.config.package_name}.repository;

import {self.config.package_name}.entity.{self.config.name};
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface {self.config.name}Repository extends JpaRepository<{self.config.name}, {id_type}>, JpaSpecificationExecutor<{self.config.name}> {{

    // Add custom query methods here
    // Example: Optional<{self.config.name}> findByEmail(String email);
}}
'''
        self._write_file(f"src/main/java/{package_path}/repository/{self.config.name}Repository.java", content)

    def _generate_service(self):
        """Generate service class with transaction management"""
        package_path = self.config.package_name.replace('.', '/')
        entity_var = self._to_camel_case(self.config.name)

        # Find ID type
        id_type = "Long"
        for f in self.config.fields:
            if f.name == "id":
                id_type = f.java_type
                break

        content = f'''package {self.config.package_name}.service;

import {self.config.package_name}.dto.{self.config.name}DTO;
import {self.config.package_name}.entity.{self.config.name};
import {self.config.package_name}.exception.ResourceNotFoundException;
import {self.config.package_name}.mapper.{self.config.name}Mapper;
import {self.config.package_name}.repository.{self.config.name}Repository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class {self.config.name}Service {{

    private final {self.config.name}Repository {entity_var}Repository;
    private final {self.config.name}Mapper {entity_var}Mapper;

    public Page<{self.config.name}DTO> findAll(Pageable pageable) {{
        log.debug("Finding all {self.config.name} entities with pagination");
        return {entity_var}Repository.findAll(pageable)
            .map({entity_var}Mapper::toDto);
    }}

    public {self.config.name}DTO findById({id_type} id) {{
        log.debug("Finding {self.config.name} by id: {{}}", id);
        return {entity_var}Repository.findById(id)
            .map({entity_var}Mapper::toDto)
            .orElseThrow(() -> new ResourceNotFoundException("{self.config.name}", "id", id));
    }}

    @Transactional
    public {self.config.name}DTO create({self.config.name}DTO dto) {{
        log.debug("Creating new {self.config.name}: {{}}", dto);
        {self.config.name} entity = {entity_var}Mapper.toEntity(dto);
        entity = {entity_var}Repository.save(entity);
        return {entity_var}Mapper.toDto(entity);
    }}

    @Transactional
    public {self.config.name}DTO update({id_type} id, {self.config.name}DTO dto) {{
        log.debug("Updating {self.config.name} id: {{}}", id);
        {self.config.name} existing = {entity_var}Repository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("{self.config.name}", "id", id));

        {entity_var}Mapper.updateEntityFromDto(dto, existing);
        existing = {entity_var}Repository.save(existing);
        return {entity_var}Mapper.toDto(existing);
    }}

    @Transactional
    public void delete({id_type} id) {{
        log.debug("Deleting {self.config.name} id: {{}}", id);
        if (!{entity_var}Repository.existsById(id)) {{
            throw new ResourceNotFoundException("{self.config.name}", "id", id);
        }}
        {entity_var}Repository.deleteById(id);
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/service/{self.config.name}Service.java", content)

    def _generate_controller(self):
        """Generate REST controller with validation"""
        package_path = self.config.package_name.replace('.', '/')
        entity_var = self._to_camel_case(self.config.name)
        endpoint = self._to_kebab_case(self.config.name) + "s"

        # Find ID type
        id_type = "Long"
        for f in self.config.fields:
            if f.name == "id":
                id_type = f.java_type
                break

        content = f'''package {self.config.package_name}.controller;

import {self.config.package_name}.dto.{self.config.name}DTO;
import {self.config.package_name}.service.{self.config.name}Service;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/{endpoint}")
@RequiredArgsConstructor
@Tag(name = "{self.config.name}", description = "{self.config.name} management APIs")
public class {self.config.name}Controller {{

    private final {self.config.name}Service {entity_var}Service;

    @GetMapping
    @Operation(summary = "Get all {self.config.name} entities with pagination")
    public ResponseEntity<Page<{self.config.name}DTO>> findAll(Pageable pageable) {{
        return ResponseEntity.ok({entity_var}Service.findAll(pageable));
    }}

    @GetMapping("/{{id}}")
    @Operation(summary = "Get a {self.config.name} by ID")
    public ResponseEntity<{self.config.name}DTO> findById(@PathVariable {id_type} id) {{
        return ResponseEntity.ok({entity_var}Service.findById(id));
    }}

    @PostMapping
    @Operation(summary = "Create a new {self.config.name}")
    public ResponseEntity<{self.config.name}DTO> create(@Valid @RequestBody {self.config.name}DTO dto) {{
        return ResponseEntity.status(HttpStatus.CREATED)
            .body({entity_var}Service.create(dto));
    }}

    @PutMapping("/{{id}}")
    @Operation(summary = "Update an existing {self.config.name}")
    public ResponseEntity<{self.config.name}DTO> update(
            @PathVariable {id_type} id,
            @Valid @RequestBody {self.config.name}DTO dto) {{
        return ResponseEntity.ok({entity_var}Service.update(id, dto));
    }}

    @DeleteMapping("/{{id}}")
    @Operation(summary = "Delete a {self.config.name}")
    public ResponseEntity<Void> delete(@PathVariable {id_type} id) {{
        {entity_var}Service.delete(id);
        return ResponseEntity.noContent().build();
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/controller/{self.config.name}Controller.java", content)

    def _generate_dto(self):
        """Generate DTO class"""
        package_path = self.config.package_name.replace('.', '/')
        imports = self._collect_dto_imports()

        # Build field declarations
        field_decls = []
        for f in self.config.fields:
            annotations = []
            if not f.nullable and f.name != "id":
                if f.java_type == "String":
                    annotations.append("@NotBlank")
                else:
                    annotations.append("@NotNull")

            annotation_str = "\n    ".join(annotations)
            if annotation_str:
                annotation_str = "    " + annotation_str + "\n"
            field_decls.append(f"{annotation_str}    private {f.java_type} {f.name};")

        content = f'''package {self.config.package_name}.dto;

{imports}

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class {self.config.name}DTO {{

{chr(10).join(field_decls)}
}}
'''
        self._write_file(f"src/main/java/{package_path}/dto/{self.config.name}DTO.java", content)

    def _generate_mapper(self):
        """Generate MapStruct mapper"""
        package_path = self.config.package_name.replace('.', '/')

        content = f'''package {self.config.package_name}.mapper;

import {self.config.package_name}.dto.{self.config.name}DTO;
import {self.config.package_name}.entity.{self.config.name};
import org.mapstruct.*;

@Mapper(componentModel = "spring")
public interface {self.config.name}Mapper {{

    {self.config.name}DTO toDto({self.config.name} entity);

    @Mapping(target = "id", ignore = true)
    {self.config.name} toEntity({self.config.name}DTO dto);

    @Mapping(target = "id", ignore = true)
    @BeanMapping(nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE)
    void updateEntityFromDto({self.config.name}DTO dto, @MappingTarget {self.config.name} entity);
}}
'''
        self._write_file(f"src/main/java/{package_path}/mapper/{self.config.name}Mapper.java", content)

    def _collect_entity_imports(self) -> str:
        """Collect required imports for entity class"""
        imports = set()

        # JPA imports
        imports.add("import jakarta.persistence.*;")
        imports.add("import lombok.*;")

        # Field type imports
        for f in self.config.fields:
            base_type = f.java_type.split('<')[0]  # Handle generics
            if base_type in self.JAVA_TYPE_IMPORTS and self.JAVA_TYPE_IMPORTS[base_type]:
                imports.add(f"import {self.JAVA_TYPE_IMPORTS[base_type]};")

        # Relation imports
        if self.config.relations:
            imports.add("import java.util.List;")
            imports.add("import java.util.ArrayList;")

        # Audit imports
        if self.config.auditable:
            imports.add("import org.springframework.data.annotation.CreatedBy;")
            imports.add("import org.springframework.data.annotation.CreatedDate;")
            imports.add("import org.springframework.data.annotation.LastModifiedBy;")
            imports.add("import org.springframework.data.annotation.LastModifiedDate;")
            imports.add("import org.springframework.data.jpa.domain.support.AuditingEntityListener;")
            imports.add("import java.time.LocalDateTime;")

        return "\n".join(sorted(imports))

    def _collect_dto_imports(self) -> str:
        """Collect required imports for DTO class"""
        imports = set()
        imports.add("import lombok.*;")

        # Validation imports
        has_validation = False
        for f in self.config.fields:
            if not f.nullable and f.name != "id":
                has_validation = True
                break

        if has_validation:
            imports.add("import jakarta.validation.constraints.*;")

        # Field type imports
        for f in self.config.fields:
            base_type = f.java_type.split('<')[0]
            if base_type in self.JAVA_TYPE_IMPORTS and self.JAVA_TYPE_IMPORTS[base_type]:
                imports.add(f"import {self.JAVA_TYPE_IMPORTS[base_type]};")

        return "\n".join(sorted(imports))

    def relations_sorted(self) -> List[RelationDefinition]:
        """Return relations sorted by type"""
        return sorted(self.config.relations, key=lambda r: r.relation_type)

    def _write_file(self, path: str, content: str):
        """Write content to a file"""
        file_path = self.output_dir / path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content)
        self.files_created.append(path)
        logger.debug(f"Created file: {path}")

    def _generate_report(self) -> Dict[str, Any]:
        """Generate a summary report"""
        return {
            "entity_name": self.config.name,
            "package": self.config.package_name,
            "fields": len(self.config.fields),
            "relations": len(self.config.relations),
            "auditable": self.config.auditable,
            "soft_delete": self.config.soft_delete,
            "files_created": self.files_created,
        }

    @staticmethod
    def _to_camel_case(name: str) -> str:
        """Convert PascalCase to camelCase"""
        return name[0].lower() + name[1:] if name else name

    @staticmethod
    def _to_snake_case(name: str) -> str:
        """Convert camelCase/PascalCase to snake_case"""
        return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

    @staticmethod
    def _to_kebab_case(name: str) -> str:
        """Convert PascalCase to kebab-case"""
        return re.sub(r'(?<!^)(?=[A-Z])', '-', name).lower()


def parse_fields(fields_str: str) -> List[FieldDefinition]:
    """Parse field definitions from command line argument"""
    fields = []
    for field_def in fields_str.split(','):
        parts = field_def.strip().split(':')
        if len(parts) >= 2:
            name = parts[0].strip()
            java_type = parts[1].strip()
            nullable = True
            unique = False
            if len(parts) > 2:
                modifiers = parts[2].strip().lower()
                nullable = 'notnull' not in modifiers and 'required' not in modifiers
                unique = 'unique' in modifiers
            fields.append(FieldDefinition(name=name, java_type=java_type, nullable=nullable, unique=unique))
    return fields


def parse_relations(relations_str: str) -> List[RelationDefinition]:
    """Parse relation definitions from command line argument"""
    relations = []
    for rel_def in relations_str.split(','):
        parts = rel_def.strip().split(':')
        if len(parts) >= 2:
            field_name = parts[0].strip()
            rel_type = parts[1].strip()

            # Infer target entity from field name
            target = field_name[0].upper() + field_name[1:]
            if rel_type in ["OneToMany", "ManyToMany"]:
                # Remove trailing 's' for collection types
                if target.endswith('s'):
                    target = target[:-1]

            relations.append(RelationDefinition(
                field_name=field_name,
                relation_type=rel_type,
                target_entity=target
            ))
    return relations


def main():
    """CLI entry point"""
    parser = argparse.ArgumentParser(
        description="JPA Entity Generator - Generate complete entity stacks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic entity
  python entity_generator.py Customer --fields "id:Long,name:String,email:String"

  # Entity with relationships
  python entity_generator.py Order --fields "id:Long,total:BigDecimal" --relations "customer:ManyToOne,items:OneToMany"

  # Entity with audit fields
  python entity_generator.py Product --fields "id:Long,name:String,price:BigDecimal" --auditable

  # Entity with custom package
  python entity_generator.py User --fields "id:Long,email:String:unique" --package com.myapp
"""
    )

    parser.add_argument("name", help="Entity name (PascalCase)")
    parser.add_argument("--fields", required=True,
                        help="Field definitions: 'name:Type,name:Type:modifiers'")
    parser.add_argument("--relations",
                        help="Relation definitions: 'field:RelationType,field:RelationType'")
    parser.add_argument("--package",
                        default="com.example",
                        help="Package name (default: com.example)")
    parser.add_argument("--output", "-o",
                        default=".",
                        help="Output directory (default: current directory)")
    parser.add_argument("--auditable", action="store_true",
                        help="Add audit fields (createdAt, updatedAt, etc.)")
    parser.add_argument("--soft-delete", action="store_true",
                        help="Add soft delete support")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable verbose output")
    parser.add_argument("--json", action="store_true",
                        help="Output result as JSON")
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s {__version__}")

    args = parser.parse_args()

    fields = parse_fields(args.fields)
    relations = parse_relations(args.relations) if args.relations else []

    config = EntityConfig(
        name=args.name,
        fields=fields,
        relations=relations,
        package_name=args.package,
        auditable=args.auditable,
        soft_delete=args.soft_delete,
    )

    generator = EntityGenerator(config, args.output, args.verbose)
    result = generator.generate()

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\nEntity '{result['entity_name']}' generated successfully!")
        print(f"Package: {result['package']}")
        print(f"\nFiles created:")
        for f in result['files_created']:
            print(f"  - {f}")


if __name__ == "__main__":
    main()
