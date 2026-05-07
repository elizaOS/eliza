/**
 * Schema viewer component displaying OpenAPI schema definitions in collapsible format.
 * Supports schema expansion, copying schema JSON, and type information display.
 *
 * @param props - Schema viewer configuration
 * @param props.spec - OpenAPI specification object
 */

"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@elizaos/cloud-ui";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, DatabaseIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import type { OpenAPISchema, OpenAPISpec } from "@/lib/swagger/openapi-generator";
import { toast } from "@/lib/utils/toast-adapter";

interface SchemaViewerProps {
  spec: OpenAPISpec | null;
}

export function SchemaViewer({ spec }: SchemaViewerProps) {
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());

  if (!spec) {
    return (
      <Card className="border-border/60 bg-background/60 rounded-none">
        <CardContent className="py-12 text-center">
          <DatabaseIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">Loading schemas...</p>
        </CardContent>
      </Card>
    );
  }

  const toggleSchema = (schemaName: string) => {
    const newExpanded = new Set(expandedSchemas);
    if (newExpanded.has(schemaName)) {
      newExpanded.delete(schemaName);
    } else {
      newExpanded.add(schemaName);
    }
    setExpandedSchemas(newExpanded);
  };

  const copySchema = async (schemaName: string, schema: OpenAPISchema) => {
    await navigator.clipboard.writeText(JSON.stringify(schema, null, 2));
    toast({
      message: `${schemaName} schema copied to clipboard`,
      mode: "success",
    });
  };

  const getTypeColor = (type: string) => {
    const base = "rounded-none px-2.5 py-1 text-xs font-medium ring-1 ring-inset";
    switch (type) {
      case "string":
        return `${base} bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300`;
      case "number":
      case "integer":
        return `${base} bg-blue-500/10 text-blue-600 ring-blue-500/30 dark:text-blue-300`;
      case "boolean":
        return `${base} bg-violet-500/10 text-violet-600 ring-violet-500/30 dark:text-violet-300`;
      case "array":
        return `${base} bg-amber-500/10 text-amber-600 ring-amber-500/30 dark:text-amber-300`;
      case "object":
        return `${base} bg-cyan-500/10 text-cyan-600 ring-cyan-500/30 dark:text-cyan-300`;
      default:
        return `${base} bg-muted text-muted-foreground`;
    }
  };

  const renderProperty = (name: string, schema: OpenAPISchema, level = 0) => {
    const isRequired = false;

    return (
      <div key={name} className="mb-3 border-l-2 border-border/60 pl-4">
        <div className="flex items-center gap-2 mb-2">
          <code className="font-mono font-semibold text-sm">{name}</code>
          {isRequired && (
            <Badge variant="destructive" className="text-xs">
              required
            </Badge>
          )}
          {schema.type && <span className={getTypeColor(schema.type)}>{schema.type}</span>}
          {schema.format && (
            <Badge variant="outline" className="text-xs">
              {schema.format}
            </Badge>
          )}
        </div>

        {schema.description && (
          <p className="mb-2 text-sm text-muted-foreground">{schema.description}</p>
        )}

        {schema.example !== undefined && (
          <div className="mb-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Example:</div>
            <code className="rounded-none bg-muted px-2 py-1 text-xs">
              {String(JSON.stringify(schema.example))}
            </code>
          </div>
        )}

        {schema.enum && (
          <div className="mb-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Enum values:</div>
            <div className="flex flex-wrap gap-1">
              {schema.enum.map((value, index) => (
                <Badge key={index} variant="outline" className="text-xs">
                  {String(JSON.stringify(value))}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {schema.type === "array" && schema.items && (
          <div className="ml-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Array items:</div>
            {renderProperty("items", schema.items, level + 1)}
          </div>
        )}

        {schema.type === "object" && schema.properties && (
          <div className="ml-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Properties:</div>
            {Object.entries(schema.properties).map(([propName, propSchema]) =>
              renderProperty(propName, propSchema, level + 1),
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSchema = (name: string, schema: OpenAPISchema) => {
    const isExpanded = expandedSchemas.has(name);

    return (
      <Card key={name} className="mb-4 border-border/60 bg-background/60 rounded-none">
        <Collapsible open={isExpanded} onOpenChange={() => toggleSchema(name)}>
          <CollapsibleTrigger className="w-full">
            <CardHeader className="cursor-pointer transition-colors hover:bg-muted/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronDownIcon className="h-4 w-4" />
                  ) : (
                    <ChevronRightIcon className="h-4 w-4" />
                  )}
                  <CardTitle className="text-lg">{name}</CardTitle>
                  {schema.type && <span className={getTypeColor(schema.type)}>{schema.type}</span>}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    copySchema(name, schema);
                  }}
                >
                  <CopyIcon className="h-4 w-4" />
                </Button>
              </div>
              {schema.description && (
                <p className="text-left text-sm text-muted-foreground">{schema.description}</p>
              )}
            </CardHeader>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent>
              {schema.type === "object" && schema.properties ? (
                <div className="space-y-4">
                  <div className="text-sm font-medium text-foreground">Properties:</div>
                  {Object.entries(schema.properties).map(([propName, propSchema]) =>
                    renderProperty(propName, propSchema),
                  )}

                  {schema.required && schema.required.length > 0 && (
                    <div className="mt-4">
                      <div className="mb-2 text-sm font-medium text-foreground">
                        Required fields:
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {schema.required.map((field) => (
                          <Badge key={field} variant="destructive" className="text-xs">
                            {field}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {schema.example !== undefined && (
                    <div>
                      <div className="mb-2 text-sm font-medium text-foreground">Example:</div>
                      <pre className="overflow-x-auto rounded-none bg-muted p-3 text-xs font-mono text-muted-foreground">
                        <code>{String(JSON.stringify(schema.example, null, 2))}</code>
                      </pre>
                    </div>
                  )}

                  {schema.enum && (
                    <div>
                      <div className="mb-2 text-sm font-medium text-foreground">
                        Possible values:
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {schema.enum.map((value, index) => (
                          <Badge key={index} variant="outline">
                            {String(JSON.stringify(value))}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  const schemas = spec.components?.schemas || {};
  const schemaEntries = Object.entries(schemas);

  return (
    <div className="flex flex-col space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">API Schemas</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Data structures and type definitions used by the API
          </p>
        </div>
        <Badge variant="outline" className="rounded-none">
          {schemaEntries.length} schemas
        </Badge>
      </div>

      {schemaEntries.length > 0 && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpandedSchemas(new Set(Object.keys(schemas)))}
          >
            Expand All
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpandedSchemas(new Set())}>
            Collapse All
          </Button>
        </div>
      )}

      {schemaEntries.length > 0 ? (
        <div className="space-y-4">
          {schemaEntries.map(([name, schema]) => renderSchema(name, schema))}
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-none border border-dashed border-border/60 bg-background/40 py-24">
          <Card className="border-none bg-transparent shadow-none">
            <CardContent className="py-12 text-center">
              <InfoIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground/60" />
              <h3 className="mb-2 text-lg font-medium text-foreground">No schemas defined</h3>
              <p className="text-sm text-muted-foreground">
                This API specification doesn&apos;t include any schema definitions.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
