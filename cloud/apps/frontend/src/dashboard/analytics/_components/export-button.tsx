/**
 * Export button component for exporting analytics data.
 * Supports CSV, JSON, and Excel formats with simple or dropdown variants.
 *
 * @param props - Export button configuration
 * @param props.startDate - Start date for export range
 * @param props.endDate - End date for export range
 * @param props.granularity - Data granularity (hour, day, month)
 * @param props.format - Export format (csv, json, excel)
 * @param props.type - Export type (timeseries, users, providers, models)
 * @param props.variant - Button variant (simple or dropdown)
 */

"use client";

import { ChevronDown, Download, Upload } from "lucide-react";
import { Button } from "@elizaos/cloud-ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@elizaos/cloud-ui";

interface ExportButtonProps {
  startDate: Date | string;
  endDate: Date | string;
  granularity: string;
  format?: "csv" | "json" | "excel";
  type?: "timeseries" | "users" | "providers" | "models";
  variant?: "simple" | "dropdown";
}

export function ExportButton({
  startDate,
  endDate,
  granularity,
  format = "csv",
  type = "timeseries",
  variant = "simple",
}: ExportButtonProps) {
  const handleExport = (
    exportFormat: "csv" | "json" | "excel",
    exportType: "timeseries" | "users" | "providers" | "models",
  ) => {
    const params = new URLSearchParams({
      format: exportFormat,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      granularity,
      type: exportType,
      includeMetadata: "true",
    });

    window.location.href = `/api/analytics/export?${params.toString()}`;
  };

  if (variant === "dropdown") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Upload className="mr-2 h-4 w-4" />
            Export data
            <ChevronDown className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Time series</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handleExport("csv", "timeseries")}>
            Export as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("excel", "timeseries")}>
            Export as Excel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("json", "timeseries")}>
            Export as JSON
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Providers</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handleExport("csv", "providers")}>
            Export as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("excel", "providers")}>
            Export as Excel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("json", "providers")}>
            Export as JSON
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Models</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handleExport("csv", "models")}>
            Export as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("excel", "models")}>
            Export as Excel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("json", "models")}>
            Export as JSON
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Users</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handleExport("csv", "users")}>
            Export as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("excel", "users")}>
            Export as Excel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExport("json", "users")}>
            Export as JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Button onClick={() => handleExport(format, type)} variant="outline" size="sm">
      <Download className="mr-2 h-4 w-4" />
      Export {format.toUpperCase()}
    </Button>
  );
}
