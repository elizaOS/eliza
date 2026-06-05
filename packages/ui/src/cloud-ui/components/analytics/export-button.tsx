"use client";

import { ChevronDown, Download, Upload } from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";

type AnalyticsExportFormat = "csv" | "json" | "excel";
type AnalyticsExportType = "timeseries" | "users" | "providers" | "models";

interface ExportButtonProps {
  startDate: Date | string;
  endDate: Date | string;
  granularity: string;
  format?: AnalyticsExportFormat;
  type?: AnalyticsExportType;
  variant?: "simple" | "dropdown";
  onExport?: (options: {
    format: AnalyticsExportFormat;
    type: AnalyticsExportType;
    startDate: Date | string;
    endDate: Date | string;
    granularity: string;
  }) => void;
}

export function ExportButton({
  startDate,
  endDate,
  granularity,
  format = "csv",
  type = "timeseries",
  variant = "simple",
  onExport,
}: ExportButtonProps) {
  const handleExport = (
    exportFormat: AnalyticsExportFormat,
    exportType: AnalyticsExportType,
  ) => {
    if (onExport) {
      onExport({
        format: exportFormat,
        type: exportType,
        startDate,
        endDate,
        granularity,
      });
      return;
    }

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
    <Button
      onClick={() => handleExport(format, type)}
      variant="outline"
      size="sm"
    >
      <Download className="mr-2 h-4 w-4" />
      Export {format.toUpperCase()}
    </Button>
  );
}

export type { AnalyticsExportFormat, AnalyticsExportType, ExportButtonProps };
