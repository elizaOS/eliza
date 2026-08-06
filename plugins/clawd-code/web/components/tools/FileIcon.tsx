"use client";

import {
  FileText,
  FileCode,
  FileJson,
  FileImage,
  File,
  Database,
  Settings,
  Package,
  Globe,
  BookOpen,
  type LucideIcon,
} from "lucide-react";

const EXT_MAP: Record<string, LucideIcon> = {
  // JavaScript / TypeScript
  js: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  // Web
  html: Globe,
  htm: Globe,
  css: FileCode,
  scss: FileCode,
  sass: FileCode,
  less: FileCode,
  // Data
  json: FileJson,
  jsonc: FileJson,
  yaml: FileJson,
  yml: FileJson,
  toml: FileJson,
  xml: FileJson,
  csv: Database,
  // Config
  env: Settings,
  gitignore: Settings,
  eslintrc: Settings,
  prettierrc: Settings,
  editorconfig: Settings,
  // Docs
  md: BookOpen,
  mdx: BookOpen,
  txt: FileText,
  rst: FileText,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  ico: FileImage,
  webp: FileImage,
  // Package
  lock: Package,
  // Python
  py: FileCode,
  pyc: FileCode,
  // Ruby
  rb: FileCode,
  // Go
  go: FileCode,
  // Rust
  rs: FileCode,
  // Java / Kotlin
  java: FileCode,
  kt: FileCode,
  // C / C++
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  hpp: FileCode,
  // Shell
  sh: FileCode,
  bash: FileCode,
  zsh: FileCode,
  fish: FileCode,
  // SQL
  sql: Database,
};

function getExtension(filePath: string): string {
  const parts = filePath.split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1].toLowerCase();
}

export function getFileIcon(filePath: string): LucideIcon {
  const ext = getExtension(filePath);
  return EXT_MAP[ext] ?? File;
}

interface FileIconProps {
  filePath: string;
  className?: string;
}

export function FileIcon({ filePath, className }: FileIconProps) {
  const Icon = getFileIcon(filePath);
  return <Icon className={className} />;
}
